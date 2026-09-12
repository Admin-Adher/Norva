'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gatewayPath = path.join(root, 'services/media-gateway/src/index.js');
const gatewaySource = fs.readFileSync(gatewayPath, 'utf8');
const { StrictLidRangeReuse, createStrictRangeCollector } = require('../services/media-gateway/src/strict-lid-range-reuse');

function brokerHarness(diagnosticLogs = null) {
  const startMarker = '// ── Strict LID loopback broker (mono-account provider barrier)';
  const endMarker = '// ── End strict LID loopback broker';
  const start = gatewaySource.indexOf(startMarker);
  const end = gatewaySource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'strict LID broker source block must remain extractable');
  const source = gatewaySource.slice(start, end);
  return vm.runInNewContext(
    `(() => { ${source}; return { parseStrictLidRange, createStrictLidBroker, createStrictLidRangeDeadline, strictLidEffectiveUrlIdentitySha256, strictLidBrokers, strictLidProviderFailureObservation, strictLidProviderRequest }; })()`,
    {
      AbortController,
      Buffer,
      Date,
      Error,
      FFMPEG_USER_AGENT: 'Norva-LID-Test/1',
      FINITE_MKV_SEEK_WINDOW_BYTES: 2 * 1024 * 1024,
      FINITE_MKV_SEEK_CACHE_BYTES: 32 * 1024 * 1024,
      Number,
      Object,
      Promise,
      PROVIDER_SLOT_RELEASE_DELAY_MS: 0,
      STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS: 30_000,
      STRICT_LID_BROKER_IDLE_TIMEOUT_MS: 15_000,
      VOD_INPUT_MAX_RECONNECTS: 1_024,
      VOD_INPUT_RETRY_DELAYS_MS: [0, 250, 1_000, 2_500],
      VOD_INPUT_RETRY_LIMIT: 3,
      Readable: require('node:stream').Readable,
      String,
      URL,
      clearTimeout,
      console: { ...console, warn: (...args) => diagnosticLogs?.push(args.join(' ')) },
      crypto: require('node:crypto'),
      createStrictRangeCollector,
      fetch,
      http,
      isHttpUrl(value) {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
          return false;
        }
      },
      isProxyAuthenticationFailure(error) {
        return /proxy_auth_failed|proxy[^\n]{0,120}(?:authentication required|response[^\n]{0,40}\b407\b)/i.test(
          String(error?.code || '') + '\n' + String(error?.message || ''),
        );
      },
      pickProxyAgent: () => null,
      proxyKeyFromUrl: () => 'provider:test',
      setImmediate,
      setTimeout,
      strictLidBrokers: new Map(),
      undiciRequest: require('undici').request,
    },
  );
}

class FakeClock {
  constructor() {
    this.now = 0;
    this.timers = new Map();
  }

  setTimeout = (callback, delay) => {
    const handle = { unref() {} };
    this.timers.set(handle, {
      at: this.now + Math.max(0, Number(delay) || 0),
      callback,
    });
    return handle;
  };

  clearTimeout = (handle) => {
    this.timers.delete(handle);
  };

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = target;
  }
}

test('finite seek closes during initial cooldown without opening another provider request', async t => {
  let calls = 0;
  const data = Buffer.alloc(64, 7);
  const provider = http.createServer((req, res) => { calls++; sendExactRange(req, res, data); });
  const sourceUrl = await listen(provider); t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes: 64,
    dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 8, completedReleaseDelayMs: 150 });
  t.after(() => broker.close());
  await (await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } })).arrayBuffer();
  const request = http.get(broker.inputUrl, { agent: false, headers: { Range: 'bytes=40-47' } });
  request.on('error', () => {});
  while (broker.maxQueuedRequests < 1) await new Promise(r => setTimeout(r, 2));
  await new Promise(r => setTimeout(r, 20)); request.destroy();
  await new Promise(r => setTimeout(r, 180));
  assert.equal(calls, 1); assert.equal(broker.avoidedProviderOpens, 1);
  assert.equal(broker.interruptedProviderFetches, 0);
});

test('finite seek closes during retry cooldown before the next provider GET', async t => {
  let calls = 0, firstSeen;
  const first = new Promise(resolve => { firstSeen = resolve; });
  const provider = http.createServer((_req, res) => { calls++; res.writeHead(503); res.end(); firstSeen(); });
  const sourceUrl = await listen(provider); t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes: 64,
    dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 8,
    releaseDelayMs: 0, finiteRetryDelaysMs: [150], finiteNoProgressRetryLimit: 1 });
  t.after(() => broker.close());
  const request = http.get(broker.inputUrl, { agent: false, headers: { Range: 'bytes=0-7' } });
  request.on('error', () => {}); await first;
  await new Promise(r => setTimeout(r, 20)); request.destroy();
  await new Promise(r => setTimeout(r, 180));
  assert.equal(calls, 1); assert.equal(broker.avoidedProviderOpens, 1);
  assert.equal(broker.terminalError, null, 'an abandoned request is not a new terminal provider failure');
});

test('finite seek rechecks demand after asynchronous dispatcher disposal', async t => {
  let now = 1, calls = 0, generation = 0, retire, retiring;
  const entered = new Promise(resolve => { retiring = resolve; });
  const gate = new Promise(resolve => { retire = resolve; });
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl: 'https://fixture.invalid/file',
    fileSizeBytes: 64, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 8, releaseDelayMs: 0,
    now: () => now, dispatcherMaxAgeMs: 5,
    dispatcherFactory: () => { const current = ++generation; return { async destroy() {
      if (current === 1) { retiring(); await gate; }
    } }; }, fetchImpl: async () => { calls++; throw Error('should not open'); } });
  t.after(async () => { retire(); await broker.close(); }); now = 10;
  const request = http.get(broker.inputUrl, { agent: false, headers: { Range: 'bytes=0-7' } });
  request.on('error', () => {}); await entered; request.destroy();
  await new Promise(r => setTimeout(r, 20)); retire();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 0); assert.equal(broker.avoidedProviderOpens, 1);
  assert.equal(broker.interruptedProviderFetches, 0);
  assert.equal(broker.windowTrace[0].outcome, 'avoided-closed');
});

test('a newer cue does not truncate a still-live primed header reader', async t => {
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  let release, firstSeen, active = 0, peak = 0;
  const gate = new Promise(r => { release = r; }), entered = new Promise(r => { firstSeen = r; });
  const provider = http.createServer(async (req, res) => {
    active++; peak = Math.max(peak, active); let done = false;
    const end = () => { if (!done) { done = true; active--; } }; res.once('finish', end); res.once('close', end);
    if (req.headers.range === 'bytes=0-1') { firstSeen(); await gate; }
    sendExactRange(req, res, data);
  });
  const sourceUrl = await listen(provider); t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes:64, dispatcher:null,
    pathPrefix:'finite-mkv-seek', finiteWarmupWindowBytes:2, finiteWarmupCueGraceMs:30,
    finiteWindowBytes:8, finiteSequentialWindowBytes:24, releaseDelayMs:0 });
  t.after(async () => { release(); await broker.close(); });
  const head = fetch(broker.inputUrl, { headers:{Range:'bytes=0-39'} }).then(r => r.arrayBuffer()); await entered;
  const cue = fetch(broker.inputUrl, { headers:{Range:'bytes=62-63'} }).then(r => r.arrayBuffer());
  while (broker.maxQueuedRequests < 2) await new Promise(r => setTimeout(r, 2));
  release();
  assert.deepEqual(Buffer.from(await head), data.subarray(0,40));
  assert.deepEqual(Buffer.from(await cue), data.subarray(62)); assert.equal(peak,1);
});

for (const defect of ['expired', 'busy', 'changed', 'ignored', 'target']) test(`finite final URL reuse fails closed on ${defect} without resolving again`, async t => {
  let entries = 0, assets = 0;
  const data = Buffer.alloc(64, 7);
  const provider = http.createServer((req, res) => {
    if (req.url === '/entry') { entries++; res.writeHead(302, { Location:'/asset?ticket=private' }); return res.end(); }
    assets++;
    if (assets === 2) {
      const status = { expired:403, busy:458, ignored:200, target:302 }[defect];
      if (status) { res.writeHead(status, defect === 'target' ? { Location:'/different-file' } : {}); return res.end(); }
    }
    sendExactRange(req,res,data,{ etag:defect === 'changed' && assets > 1 ? '"v2"' : '"v1"' });
  });
  const origin = new URL(await listen(provider)).origin; t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl:origin+'/entry',fileSizeBytes:64,
    dispatcher:null,pathPrefix:'finite-mkv-seek',finiteWindowBytes:8,releaseDelayMs:0 }); t.after(()=>broker.close());
  await (await fetch(broker.inputUrl,{headers:{Range:'bytes=0-7'}})).arrayBuffer();
  const response = await fetch(broker.inputUrl,{headers:{Range:'bytes=40-47'}});
  assert.notEqual(response.status,206); await response.arrayBuffer();
  assert.equal(broker.terminalError.code, { expired:'PROVIDER_REQUEST_FAILED', busy:'PROVIDER_BUSY',
    changed:'VOD_CHANGED', ignored:'RANGE_UNSUPPORTED', target:'VOD_CHANGED' }[defect]);
  const count = assets;
  await (await fetch(broker.inputUrl,{headers:{Range:'bytes=50-57'}})).arrayBuffer();
  assert.equal(entries,1); assert.equal(assets,count);
  assert.doesNotMatch(JSON.stringify(broker.windowTrace),/ticket|private|\/asset|https?:/);
});

test('redirect target policy runs before I/O and origin credentials are stripped across hosts', async t => {
  const observed = [];
  const destination = http.createServer((req,res)=>{ observed.push(req.headers); res.writeHead(403); res.end(); });
  const dest = await listen(destination); t.after(()=>closeServer(destination));
  const source = http.createServer((_req,res)=>{ res.writeHead(302,{Location:dest+'/asset'}); res.end(); });
  const origin = await listen(source); t.after(()=>closeServer(source));
  const { strictLidProviderRequest } = brokerHarness();
  const result = await strictLidProviderRequest(origin, { headers:{ Authorization:'secret',Cookie:'secret',
    'Proxy-Authorization':'secret',Range:'bytes=0-7'}, assertProviderTarget:url=>assert.ok(url.startsWith(origin)||url.startsWith(dest)) });
  assert.equal(result.redirects,1); assert.equal(observed.length,1);
  for(const name of ['authorization','cookie','proxy-authorization']) assert.equal(observed[0][name],undefined);
  assert.equal(observed[0].range,'bytes=0-7');
  await assert.rejects(strictLidProviderRequest(origin,{assertProviderTarget:url=>{ if(url.startsWith(dest))throw Error('target denied'); }}),/target denied/);
  assert.equal(observed.length,1,'denied destination was never opened');
});

test('finite TS repeat broker revalidates current data before using private sparse fragments', async t => {
  const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
  const cache = new FinitePlaybackRangeReuse(); const data=Buffer.from(Array.from({length:128},(_,i)=>i));
  let calls=0, etag='"v1"', status=206;
  const provider=http.createServer((req,res)=>{calls++; if(status!==206){res.writeHead(status);res.end();return;}sendExactRange(req,res,data,{etag});});
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const run=async()=>{
    const before=calls;
    const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:128,dispatcher:null,
      pathPrefix:'finite-mkv-seek',finiteWindowBytes:8,finiteWarmupWindowBytes:2,releaseDelayMs:0,
      finiteResumeRanges:cache.begin({ownerKey:'a'.repeat(64),sourceUrl,fileSizeBytes:128})});
    try{
      for(const [from,to] of [[0,1],[120,127],[32,39]]){
        const response=await fetch(broker.inputUrl,{headers:{Range:`bytes=${from}-${to}`}});
        if(status!==206){assert.notEqual(response.status,206);await response.arrayBuffer();return {calls:calls-before,reused:broker.resumeRangeReusedBytes};}
        assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(from,to+1));
      }
      return {calls:calls-before,reused:broker.resumeRangeReusedBytes};
    }finally{await broker.close();}
  };
  assert.deepEqual(await run(),{calls:3,reused:0});
  assert.deepEqual(await run(),{calls:1,reused:16});
  etag='"v2"';assert.deepEqual(await run(),{calls:3,reused:0},'stale cache is ignored with no forced representation');
  await run();status=403;assert.deepEqual(await run(),{calls:1,reused:0},'cache never bypasses current provider refusal');
});

test('sparse resume clips a missing provider range BEFORE opening it and preserves a continuous local response', async t => {
  const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
  const cache=new FinitePlaybackRangeReuse(),data=Buffer.from(Array.from({length:128},(_,i)=>i)),calls=[];
  const provider=http.createServer((req,res)=>{calls.push(req.headers.range);sendExactRange(req,res,data,{etag:'"v1"'});});
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const options={sourceUrl,fileSizeBytes:128,dispatcher:null,pathPrefix:'finite-mkv-seek',finiteWindowBytes:64,
    finiteWarmupWindowBytes:2,finiteCacheBytes:128,releaseDelayMs:0};
  const make=()=>brokerHarness().createStrictLidBroker({...options,
    finiteResumeRanges:cache.begin({ownerKey:'a'.repeat(64),sourceUrl,fileSizeBytes:128})});
  const seed=await make();
  try { await (await fetch(seed.inputUrl,{headers:{Range:'bytes=32-39'}})).arrayBuffer(); } finally { await seed.close(); }
  calls.length=0;const broker=await make();t.after(()=>broker.close());
  const response=await fetch(broker.inputUrl,{headers:{Range:'bytes=0-127'}});
  assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),data);
  assert.ok(calls.includes('bytes=2-31'));assert.ok(!calls.some(r=>r==='bytes=2-63'));
  assert.equal(broker.resumeRangeReusedBytes,8);assert.equal(broker.terminalError,null);
});

test('native finite TS far seek: serialized broker preserves decoded media without provider overlap',
  { skip: process.env.NORVA_TS_BROKER_NATIVE !== '1', timeout: 180_000 }, async () => {
  const { spawn } = require('node:child_process');
  const { finiteTsHttpArgs, finiteTsDemuxArgs } = require('../services/media-gateway/src/finite-ts-startup');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'norva-ts-broker-'));
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err = (err + b).slice(-3000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(`native FFmpeg ${code}: ${err}`)); });
  });
  let provider, broker;
  try {
    const fixture = path.join(dir, 'vod.ts');
    await run(['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25',
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','300',
      '-c:v','libx264','-threads','1','-preset','ultrafast','-g','300','-keyint_min','300',
      '-sc_threshold','0','-bf','0','-c:a','aac','-ac','2','-f','mpegts',fixture]);
    const size = fs.statSync(fixture).size;
    assert.ok(size > 8 * 1024 * 1024 && size < 64 * 1024 * 1024, `fixture size ${size}`);
    let active = 0, peak = 0, requests = 0, bytes = 0;
    provider = http.createServer((req, res) => {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const from = range ? Number(range[1]) : 0, to = Math.min(size - 1, range?.[2] ? Number(range[2]) : size - 1);
      if (from >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      requests++; active++; peak = Math.max(peak, active);
      let stream, settled = false;
      const finish = () => { if (!settled) { settled = true; active--; } clearTimeout(timer); stream?.destroy(); };
      const timer = setTimeout(() => {
        res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Length': to-from+1,
          'Content-Range': `bytes ${from}-${to}/${size}`, 'Accept-Ranges': 'bytes', ETag: '"ts-fixture-v1"' });
        stream = fs.createReadStream(fixture, { start: from, end: to });
        stream.on('data', b => { bytes += b.length; }); stream.pipe(res);
      }, 80);
      res.once('finish', finish); res.once('close', finish);
    });
    const url = await listen(provider);
    const results = [];
    const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
    const resumeCache = new FinitePlaybackRangeReuse();
    for (const {windowMiB,lookbehindBytes,reuse} of [0, 1, 4, 8].map(windowMiB=>({windowMiB,lookbehindBytes:0}))
      .concat(['cold','warm'].map(reuse => ({windowMiB:1,lookbehindBytes:256*1024,reuse})))) {
      const buffered = windowMiB > 0;
      requests = 0; peak = 0; bytes = 0;
      if (buffered) broker = await brokerHarness().createStrictLidBroker({
        sourceUrl: url, fileSizeBytes: size, pathPrefix: 'finite-mkv-seek', dispatcher: null,
        finiteWindowBytes: windowMiB*1024*1024, finiteWarmupWindowBytes: 256*1024,
        finiteSeekLookbehindBytes: lookbehindBytes,
        finiteSeekContinuationGraceMs: lookbehindBytes ? 50 : 0,
        finiteAbandonedDrainMs: lookbehindBytes ? 1500 : 0,
        finiteWarmupCueGraceMs: 0, finiteSequentialWindowBytes: 8*1024*1024,
        finiteCacheBytes: 64*1024*1024, finiteResumePrefixCandidate: null, onFiniteResumePrefix: null,
        finiteResumeRanges: reuse ? resumeCache.begin({ownerKey:'a'.repeat(64),sourceUrl:url,fileSizeBytes:size}) : null,
        completedReleaseDelayMs: 0, supersededReleaseDelayMs: 100,
      });
      const output = path.join(dir, `${buffered}.ts`), started = Date.now();
      await run(['-v','error','-y', ...(buffered ? ['-seekable','1','-rw_timeout','50000000'] : finiteTsHttpArgs()),
        ...finiteTsDemuxArgs(), '-analyzeduration','500000','-probesize','524288','-ss','222',
        '-i', buffered ? broker.inputUrl : url, '-ss','15','-t','8','-map','0:v:0','-map','0:a:0',
        '-c:v','libx264','-threads','1','-preset','ultrafast','-g','50','-c:a','aac','-f','mpegts',output]);
      const elapsedMs = Date.now() - started;
      const reusedBytes = broker?.resumeRangeReusedBytes || 0;
      if (broker) { await broker.close(); broker = null; }
      const hashes = await run(['-v','error','-i',output,'-map','0:v:0','-frames:v','12','-f','framemd5','-']);
      const audio = await run(['-v','error','-i',output,'-map','0:a:0','-t','1','-f','md5','-']);
      const result = { buffered, windowMiB, lookbehindBytes, reuse, reusedBytes, elapsedMs, requests, peak, bytes,
        frames: hashes.split('\n').filter(x => x && !x.startsWith('#')).map(x => x.split(',').at(-1).trim()), audio };
      results.push(result);
      console.log('native TS broker metrics', JSON.stringify({ buffered, windowMiB, lookbehindBytes, reuse, reusedBytes, elapsedMs, requests, peak, bytes }));
      assert.equal(active, 0);
    }
    for (const result of results.slice(1)) {
      assert.deepEqual(result.frames, results[0].frames, 'same twelve decoded frames at the requested far seek');
      assert.equal(result.audio, results[0].audio, 'same aligned decoded audio');
      assert.equal(result.peak, 1, 'never two provider HTTP operations at once');
      // A one-MiB exploratory window can tie baseline depending on FFmpeg's
      // prefetch scheduling. The selected four-MiB production window must win.
      if (result.windowMiB === 4) assert.ok(result.requests < results[0].requests, 'selected window reduces provider round trips');
    }
    const cold=results.find(r=>r.reuse==='cold'),warm=results.find(r=>r.reuse==='warm');
    assert.ok(warm.requests < cold.requests,'validated repeat resume uses fewer provider operations');
    assert.ok(warm.reusedBytes > 0,'previous-session bytes actually used');
  } finally {
    await broker?.close();
    if (provider) await closeServer(provider);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finite TS lookbehind returns only requested bytes and reuses backwards timestamp searches', { timeout: 8000 }, async (t) => {
  const data = Buffer.from(Array.from({ length: 128 }, (_, i) => i));
  const calls = [];
  const provider = http.createServer((req, res) => { calls.push(req.headers.range); sendExactRange(req, res, data); });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes: data.length,
    pathPrefix: 'finite-mkv-seek', dispatcher: null, finiteWindowBytes: 16,
    finiteSeekLookbehindBytes: 8, finiteCacheBytes: 128, releaseDelayMs: 0 });
  t.after(() => broker.close());
  for (const [from, to] of [[125,127],[122,127],[119,127],[90,95],[85,95],[80,95],[0,10]]) {
    const r = await fetch(broker.inputUrl, { headers: { Range: `bytes=${from}-${to}` } });
    assert.equal(r.headers.get('content-range'), `bytes ${from}-${to}/128`);
    assert.equal(r.headers.get('content-length'), String(to-from+1));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(from,to+1));
  }
  assert.deepEqual(calls, ['bytes=117-127','bytes=82-95','bytes=72-81','bytes=0-10']);
  assert.equal(broker.interruptedProviderFetches,0);
  assert.ok(broker.cacheHits >= 4);
});

test('finite TS lookbehind resumes a truncated preceding slice without duplicate local bytes', { timeout: 8000 }, async (t) => {
  const data = Buffer.from(Array.from({ length: 64 }, (_, i) => i)), calls = [];
  const provider = http.createServer((req,res) => {
    const {start,end} = exactRange(req,data.length); calls.push(req.headers.range);
    if (calls.length !== 1) return sendExactRange(req,res,data,{etag:'"vod-v1"'});
    res.writeHead(206, {'Content-Length':String(end-start+1), 'Content-Range':`bytes ${start}-${end}/64`, ETag:'"vod-v1"'});
    res.write(data.subarray(start,start+3)); setTimeout(() => res.destroy(),20);
  });
  const sourceUrl = await listen(provider); t.after(() => closeServer(provider));
  const broker = await brokerHarness().createStrictLidBroker({ sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:16,finiteSeekLookbehindBytes:8,
    releaseDelayMs:0, finiteRetryDelaysMs:[0], finiteNoProgressRetryLimit:1 });
  t.after(() => broker.close());
  const response = await fetch(broker.inputUrl,{headers:{Range:'bytes=12-15'}});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),data.subarray(12,16));
  assert.deepEqual(calls,['bytes=4-15','bytes=7-15']);
  assert.equal(broker.interruptedProviderFetches,1);
  assert.equal(broker.terminalError,null);
});

for (const fail of ['validator','range','busy']) test(`finite TS lookbehind keeps ${fail} terminal before serving a preceding slice`, {timeout:8000}, async(t) => {
  const data=Buffer.alloc(64,1); let calls=0;
  const provider=http.createServer((req,res)=>{
    calls++;
    if(fail==='busy'){res.writeHead(458,{'Content-Length':'0'});return res.end();}
    sendExactRange(req,res,data,{etag:fail==='validator'?'"changed"':'"original"',contentRange:fail==='range'?'bytes 4-15/65':undefined});
  });
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:16,finiteSeekLookbehindBytes:8,
    expectedValidator:{header:'If-Range',kind:'etag',value:'"original"'},releaseDelayMs:0});t.after(()=>broker.close());
  const response=await fetch(broker.inputUrl,{headers:{Range:'bytes=12-15'}});
  await response.arrayBuffer();
  assert.notEqual(response.status,206);assert.equal(calls,1);assert.ok(broker.terminalError);
});

test('finite TS lookbehind coalesces another reader after a partial reconnect without replaying bytes', {timeout:8000}, async(t)=>{
  const data=Buffer.from(Array.from({length:64},(_,i)=>i));let calls=0,active=0,peak=0,started;
  const firstStarted=new Promise(r=>{started=r});
  const provider=http.createServer((req,res)=>{
    calls++;active++;peak=Math.max(peak,active);let ended=false;
    const release=()=>{if(!ended){ended=true;active--}};res.once('finish',release);res.once('close',release);
    if(calls!==1)return sendExactRange(req,res,data);
    const {start,end}=exactRange(req,64);
    res.writeHead(206,{'Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/64`,ETag:'"fixture-v1"'});
    res.write(data.subarray(start,14));started();setTimeout(()=>res.destroy(),30);
  });
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:16,finiteSeekLookbehindBytes:8,finiteCacheBytes:64,
    releaseDelayMs:0,finiteRetryDelaysMs:[40]});t.after(()=>broker.close());
  const first=fetch(broker.inputUrl,{headers:{Range:'bytes=12-31'}}).then(async r=>Buffer.from(await r.arrayBuffer()));
  await firstStarted;
  const second=fetch(broker.inputUrl,{headers:{Range:'bytes=12-31'}}).then(async r=>Buffer.from(await r.arrayBuffer()));
  for(const body of await Promise.all([first,second]))assert.deepEqual(body,data.subarray(12,32));
  assert.equal(peak,1);assert.equal(active,0);assert.equal(broker.interruptedProviderFetches,1);
  assert.equal(broker.terminalError,null);
});

test('strict language acquisition ignores the finite TS lookbehind option', {timeout:8000}, async(t)=>{
  const data=Buffer.alloc(32),calls=[];
  const provider=http.createServer((req,res)=>{calls.push(req.headers.range);sendExactRange(req,res,data);});
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:32,dispatcher:null,
    finiteSeekLookbehindBytes:256*1024,releaseDelayMs:0});t.after(()=>broker.close());
  const r=await fetch(broker.inputUrl,{headers:{Range:'bytes=16-23'}});await r.arrayBuffer();
  assert.deepEqual(calls,['bytes=16-23']);assert.equal(broker.seekLookbehindBytes,0);
});

test('finite TS continuation grace avoids opening a provider window after libav closes its cached read', {timeout:8000},async(t)=>{
  const data=Buffer.alloc(64,7),calls=[];
  const provider=http.createServer((req,res)=>{calls.push(req.headers.range);sendExactRange(req,res,data);});
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:8,finiteSeekContinuationGraceMs:60,releaseDelayMs:0});t.after(()=>broker.close());
  const first=await fetch(broker.inputUrl,{headers:{Range:'bytes=0-31'}}),reader=first.body.getReader();
  assert.equal((await reader.read()).value.length,8);await reader.cancel();
  const second=await fetch(broker.inputUrl,{headers:{Range:'bytes=24-31'}});
  assert.deepEqual(Buffer.from(await second.arrayBuffer()),data.subarray(24,32));
  assert.deepEqual(calls,['bytes=0-7','bytes=24-31']);assert.equal(broker.interruptedProviderFetches,0);
});

for(const drain of [true,false])test(`finite TS abandoned drain ${drain?'finishes a small exact body':'expires without provider overlap'}`,{timeout:8000},async(t)=>{
  const data=Buffer.alloc(64,7);let calls=0,active=0,peak=0,timer;
  const provider=http.createServer((req,res)=>{
    calls++;active++;peak=Math.max(peak,active);let closed=false;
    const close=()=>{if(!closed){closed=true;active--}};res.once('finish',close);res.once('close',close);
    if(calls>1)return sendExactRange(req,res,data);
    res.writeHead(206,{'Content-Length':'16','Content-Range':'bytes 0-15/64',ETag:'"fixture-v1"'});
    res.write(data.subarray(0,4));
    if(drain)timer=setTimeout(()=>res.end(data.subarray(4,16)),30);
  });
  const sourceUrl=await listen(provider);t.after(()=>{clearTimeout(timer);return closeServer(provider)});
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:16,finiteAbandonedDrainMs:80,
    completedReleaseDelayMs:0,supersededReleaseDelayMs:30,releaseDelayMs:0});t.after(()=>broker.close());
  const first=await fetch(broker.inputUrl,{headers:{Range:'bytes=0-31'}}),reader=first.body.getReader();
  await reader.read();await reader.cancel();const started=Date.now();
  const second=await fetch(broker.inputUrl,{headers:{Range:'bytes=32-39'}});
  assert.deepEqual(Buffer.from(await second.arrayBuffer()),data.subarray(32,40));
  assert.equal(calls,2);assert.equal(peak,1);assert.equal(active,0);
  assert.equal(broker.interruptedProviderFetches,drain?0:1);
  if(!drain)assert.ok(Date.now()-started>=90,'bounded drain then normal slot release');
});

test('viewer cancellation bypasses an abandoned TS drain immediately', {timeout:8000},async(t)=>{
  const data=Buffer.alloc(64);let active=0;
  const provider=http.createServer((req,res)=>{active++;res.once('close',()=>active--);
    res.writeHead(206,{'Content-Length':'16','Content-Range':'bytes 0-15/64',ETag:'"fixture-v1"'});res.write(data.subarray(0,4));});
  const sourceUrl=await listen(provider);t.after(()=>closeServer(provider));
  const broker=await brokerHarness().createStrictLidBroker({sourceUrl,fileSizeBytes:64,dispatcher:null,
    pathPrefix:'finite-mkv-seek',finiteWindowBytes:16,finiteAbandonedDrainMs:1500,releaseDelayMs:0});t.after(()=>broker.close());
  const first=await fetch(broker.inputUrl,{headers:{Range:'bytes=0-31'}}),reader=first.body.getReader();
  await reader.read();await reader.cancel();
  const pending=fetch(broker.inputUrl,{headers:{Range:'bytes=32-39'}}).catch(()=>null);
  await new Promise(r=>setTimeout(r,20));const started=Date.now();await broker.close('viewer-preempted');await pending;
  assert.ok(Date.now()-started<800,'cancellation must not wait the 1500ms optional drain');
  await new Promise(r=>setTimeout(r,20));assert.equal(active,0);
});

function audioExtractionHarness(spawnImpl, timers = {}) {
  const start = gatewaySource.indexOf('function extractAudioWav(');
  const end = gatewaySource.indexOf('// V2 chunked pipeline', start);
  assert.ok(start >= 0 && end > start, 'audio extraction source must remain dynamically extractable');
  return vm.runInNewContext(
    `(() => { ${gatewaySource.slice(start, end)}; return extractAudioWav; })()`,
    {
      ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION: 'language-validation',
      FFMPEG_PATH: 'ffmpeg-test',
      STRICT_LID_FFMPEG_RW_TIMEOUT_US: 50_000_000,
      clearTimeout: timers.clearTimeout || clearTimeout,
      console: { warn() {} },
      crypto: require('node:crypto'),
      fsp: {
        async stat() { return { size: 0 }; },
        async unlink() {},
      },
      isHttpUrl: () => true,
      loopbackOnlyEnv: () => ({}),
      os: require('node:os'),
      path,
      proxyEnvFor: () => ({}),
      proxyKeyFromUrl: () => 'provider:test',
      redactCreds: (value) => String(value),
      redactStrictLidLoopback: (value) => String(value),
      registerAccountExtraction: () => ({ preempted: false, release() {} }),
      setTimeout: timers.setTimeout || setTimeout,
      spawn: spawnImpl,
      viewerPlaybackActiveLocally: () => false,
    },
  );
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}/movie/account/secret/file.mkv`;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    try { server.close(resolve); } catch (_) { resolve(); }
    try { server.closeAllConnections?.(); } catch (_) {}
  });
}

function exactRange(req, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range || ''));
  assert.ok(match, `provider received a non-exact range: ${String(req.headers.range || '')}`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end));
  assert.ok(start >= 0 && end >= start && end < size);
  return { start, end };
}

function sendExactRange(req, res, data, options = {}) {
  const { start, end } = exactRange(req, data.length);
  const body = data.subarray(start, end + 1);
  res.statusCode = options.status || 206;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Range', options.contentRange || `bytes ${start}-${end}/${data.length}`);
  if (options.contentLength !== false) {
    res.setHeader('Content-Length', String(options.contentLength ?? body.length));
  }
  if (options.contentEncoding) res.setHeader('Content-Encoding', options.contentEncoding);
  if (options.etag !== false) res.setHeader('ETag', options.etag || '"fixture-v1"');
  res.end(options.body || body);
}

test('strict range reuse revalidates across brokers and fetches only missing bytes on the same mono account', async t => {
  const data = Buffer.alloc(40000, 0x69); const requests = []; let bytes = 0; let active = 0; let maximum = 0;
  const provider = http.createServer((req, res) => {
    const r = exactRange(req, data.length); requests.push({ ...r, conditional: req.headers['if-range'] });
    bytes += r.end - r.start + 1; maximum = Math.max(maximum, ++active);
    res.once('close', () => active--); sendExactRange(req, res, data);
  });
  const url = await listen(provider); t.after(() => closeServer(provider));
  const cache = new StrictLidRangeReuse();
  const binding = { userHash: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64), profileHash: 'c'.repeat(64), fileSizeBytes: data.length };
  const { createStrictLidBroker } = brokerHarness();
  const first = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse: cache.begin(binding) });
  t.after(() => first.close());
  let response = await fetch(first.inputUrl, { headers: { Range: 'bytes=0-9999' } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(0, 10000));
  await first.close();
  assert.equal(bytes, 10000); assert.equal(cache.snapshot().bytes, 10000);
  const second = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse: cache.begin(binding) });
  t.after(() => second.close());
  response = await fetch(second.inputUrl, { headers: { Range: 'bytes=0-19999' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-length'), '20000');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(0, 20000));
  assert.equal(bytes, 20001); assert.equal(second.providerBytes, 10001);
  assert.deepEqual(requests.map(r => [r.start, r.end]), [[0, 9999], [0, 0], [10000, 19999]]);
  assert.equal(requests[1].conditional, '"fixture-v1"');
  response = await fetch(second.inputUrl, { headers: { Range: 'bytes=8000-11999' } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(8000, 12000));
  assert.equal(requests.length, 3); assert.equal(maximum, 1);
  await second.close();
  assert.equal(cache.snapshot().reusedBytes, 13999);
});

test('strict range reuse rejects changed or busy providers before any stale bytes can be served', async t => {
  for (const rejection of ['etag', 'busy', 'weak', 'precondition']) {
    let change = false; let calls = 0;
    const data = Buffer.alloc(5000, 0x66);
    const provider = http.createServer((req, res) => {
      calls++;
      if (change && ['busy', 'precondition'].includes(rejection)) {
        res.statusCode = rejection === 'busy' ? 458 : 412; return res.end();
      }
      sendExactRange(req, res, data, { etag: !change ? '"fixture-v1"' : rejection === 'etag' ? '"different"' : 'W/"fixture-v1"' });
    });
    const url = await listen(provider); t.after(() => closeServer(provider));
    const cache = new StrictLidRangeReuse();
    const binding = { userHash: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64), profileHash: 'c'.repeat(64), fileSizeBytes: data.length };
    const { createStrictLidBroker } = brokerHarness();
    const first = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse: cache.begin(binding) });
    t.after(() => first.close());
    await (await fetch(first.inputUrl, { headers: { Range: 'bytes=0-4999' } })).arrayBuffer(); await first.close();
    change = true;
    const second = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse: cache.begin(binding) });
    t.after(() => second.close());
    const response = await fetch(second.inputUrl, { headers: { Range: 'bytes=0-4999' } });
    assert.ok(response.status >= 400, rejection); await response.arrayBuffer();
    assert.equal(second.terminalError.code, rejection === 'busy' ? 'PROVIDER_BUSY' : 'VOD_CHANGED');
    await second.close(); assert.equal(cache.snapshot().bytes, 0); assert.equal(cache.snapshot().reusedBytes, 0);
    assert.equal(calls, 2, 'no automatic retry after rejection');
  }
});

test('a provider without a strong validator stays on the unchanged strict path without false cache hits', async t => {
  let calls = 0; const data = Buffer.alloc(5000, 0x23);
  const provider = http.createServer((req, res) => { calls++; sendExactRange(req, res, data, { etag: false }); });
  const url = await listen(provider); t.after(() => closeServer(provider));
  const cache = new StrictLidRangeReuse(); const { createStrictLidBroker } = brokerHarness();
  for (let i = 0; i < 2; i++) {
    const session = cache.begin({ userHash: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64), profileHash: 'c'.repeat(64), fileSizeBytes: data.length });
    const broker = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse: session });
    t.after(() => broker.close());
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-4999' } });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data); await broker.close();
  }
  assert.equal(calls, 2); assert.equal(cache.snapshot().bytes, 0);
});

test('native FFmpeg uses actual strict broker and reuses headers between distinct temporal windows',
  { skip: process.env.NORVA_CAPTURE_REAL_FFMPEG !== '1' }, async t => {
  const fsp = require('node:fs/promises'); const { spawn } = require('node:child_process');
  const { runStrictLidMultiExtract } = require('../services/media-gateway/src/strict-lid-multi-extract');
  const { parsePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
  const dir = await fsp.mkdtemp(path.join(require('node:os').tmpdir(), 'norva-range-ffmpeg-'));
  const source = path.join(dir, 'synthetic.mkv'); const output = path.join(dir, 'out.wav');
  t.after(async () => { await fsp.unlink(source).catch(() => {}); await fsp.unlink(output).catch(() => {}); await fsp.rmdir(dir); });
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'aevalsrc=sin(2*PI*(300*t+3*t*t)):s=16000:d=60', '-c:a', 'pcm_s16le', source], { stdio: 'ignore' });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('fixture_generation_failed')));
  });
  const data = await fsp.readFile(source);
  const server = http.createServer((req, res) => sendExactRange(req, res, data));
  const url = await listen(server); t.after(() => closeServer(server));
  const { createStrictLidBroker } = brokerHarness();
  const run = async cache => {
    let receivedBytes = 0; let requests = 0; const hashes = [];
    for (const start of [0, 30]) {
      const rangeReuse = cache?.begin({ userHash: 'a'.repeat(64), sourceUrlHash: 'b'.repeat(64),
        profileHash: 'c'.repeat(64), fileSizeBytes: data.length });
      const broker = await createStrictLidBroker({ sourceUrl: url, fileSizeBytes: data.length, rangeReuse });
      try {
        const result = await runStrictLidMultiExtract({ bin: 'ffmpeg', inputUrl: broker.inputUrl,
          outputs: [{ index: 0, path: output }], startSeconds: start, durationSeconds: 20, timeoutMs: 30000 });
        assert.equal(result.ok, true, broker.terminalError?.code || result.code);
        const wav = await fsp.readFile(output); assert.equal(parsePcm16Wav(wav).durationSeconds, 20);
        hashes.push(require('node:crypto').createHash('sha256').update(wav).digest('hex'));
      } finally { await broker.close(); }
      receivedBytes += broker.providerBytes; requests += broker.providerFetches;
    }
    assert.notEqual(hashes[0], hashes[1], 'distinct synthetic temporal evidence is preserved');
    return { receivedBytes, requests, hashes };
  };
  const baseline = await run(null); const cache = new StrictLidRangeReuse(); const reused = await run(cache);
  assert.deepEqual(reused.hashes, baseline.hashes, 'cache must be transparent to demuxed PCM');
  assert.ok(cache.snapshot().reusedBytes > 0, 'actual FFmpeg reused its header/cue requests');
  assert.ok(reused.receivedBytes < baseline.receivedBytes, 'fewer media bytes read by the broker');
  t.diagnostic(JSON.stringify({ fixture: 'synthetic-two-temporal-windows', baseline, reused,
    reuse: cache.snapshot(), externalProviderRequests: 0 }));
});

test('strict provider diagnostics retain only safe cause codes and bounded stage counters', () => {
  const { strictLidProviderFailureObservation: observe } = brokerHarness();
  const cause = Object.assign(new Error('https://provider.invalid/account/password'), { code: 'ECONNRESET' });
  const outer = new TypeError('Bearer secret-token', { cause });
  const result = observe(outer, {
    stage: 'request', elapsedMs: 12, progressBytes: 0, upstreamStatus: null,
    url: 'https://secret.invalid', jobId: 'private-job', transcript: 'private-speech',
  });
  assert.deepEqual({ ...result }, {
    event: 'strict_lid_provider_failure', protocol: 1, mode: 'strict-language',
    stage: 'request', errorType: 'Error', errorCode: 'ECONNRESET', reason: null,
    upstreamStatus: null, proxyConnectStatus: null, timeout: null, elapsedMs: 12, progressBytes: 0,
    validatorKind: null, targetIdentityMatch: null,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|private|Bearer|https?:/);
  const malformed = observe({ code: 'secret', name: 'secret', cause: null }, {
    finiteSeek: true, stage: 'secret', elapsedMs: NaN, progressBytes: -1,
    upstreamStatus: 999, timeoutKind: 'secret',
  });
  assert.equal(malformed.stage, 'unknown');
  assert.equal(malformed.errorCode, null);
  assert.equal(malformed.errorType, 'Error');
  assert.equal(malformed.elapsedMs, null);
  assert.equal(malformed.progressBytes, null);
  assert.equal(malformed.upstreamStatus, null);
  assert.equal(malformed.timeout, null);
});

test('strict provider diagnostics tolerate cyclic, throwing and changing error getters', () => {
  const { strictLidProviderFailureObservation: observe } = brokerHarness();
  const cyclic = { code: 'UND_ERR_SOCKET' }; cyclic.cause = cyclic;
  assert.equal(observe(cyclic).errorCode, 'UND_ERR_SOCKET');
  const throwing = { get code() { throw new Error('private'); }, cause: cyclic };
  assert.equal(observe(throwing).errorCode, 'UND_ERR_SOCKET');
  let reads = 0;
  const changing = { get code() { return reads++ === 0 ? 'EPIPE' : 'private'; } };
  assert.equal(observe(changing).errorCode, 'EPIPE');
  assert.equal(reads, 1);
  assert.doesNotThrow(() => observe({ get cause() { throw new Error('private'); } }));
  assert.equal(observe(new Error('The media provider target changed during the byte-range session.')).reason, 'effective-target-changed');
  assert.equal(observe(new Error('The media file changed during language validation.')).reason, 'validator-changed');
  assert.equal(observe(new Error('The media file changed during language validation. secret')).reason, null);
  assert.equal(observe(new Error('Proxy response (502) !== 200 when HTTP Tunneling private')).proxyConnectStatus,null);
});

test('real Undici refused CONNECT is diagnosed as proxy status, without a provider response or retry', async t => {
  const { ProxyAgent, request }=require('undici');
  const { strictLidProviderFailureObservation: observe }=brokerHarness();
  let connects=0;let unexpected=0;const sockets=new Set();
  const proxy=http.createServer((_req,res)=>{unexpected++;res.writeHead(500);res.end();});
  proxy.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  proxy.on('connect',(_req,socket)=>{connects++;socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const agent=new ProxyAgent(`http://127.0.0.1:${proxy.address().port}`);
  t.after(async()=>{await agent.close();for(const socket of sockets)socket.destroy();await new Promise(resolve=>proxy.close(resolve));});
  let observed;
  await assert.rejects(request('https://fixture.invalid/private-source', {dispatcher:agent,signal:AbortSignal.timeout(3000)}),error=>{
    observed=observe(error,{stage:'request',progressBytes:0,upstreamStatus:null});
    assert.equal(error.code,'UND_ERR_ABORTED');return true;
  });
  assert.equal(observed.proxyConnectStatus,502);assert.equal(observed.upstreamStatus,null);
  assert.equal(observed.errorCode,'UND_ERR_ABORTED');assert.equal(connects,1);assert.equal(unexpected,0);
  assert.doesNotMatch(JSON.stringify(observed),/fixture|private-source|127\.0\.0\.1/);
});

test('strict transport failure logs the request stage without changing public error or retry policy', async (t) => {
  const logs = [];
  const { createStrictLidBroker } = brokerHarness(logs);
  let fetches = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/private/password/file.mkv',
    fileSizeBytes: 100, dispatcher: null, releaseDelayMs: 0,
    fetchImpl: async () => {
      fetches++;
      throw Object.assign(new TypeError('private provider password'), { code: 'UND_ERR_INVALID_ARG' });
    },
  });
  t.after(() => broker.close());
  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'PROVIDER_FETCH_FAILED');
  assert.equal(fetches, 1);
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.equal(event.stage, 'request');
  assert.equal(event.errorCode, 'UND_ERR_INVALID_ARG');
  assert.equal(event.upstreamStatus, null);
  assert.equal(event.progressBytes, 0);
  assert.doesNotMatch(logs.join(''), /private|password|provider\.invalid/);
});

test('strict upstream rejection records the actual HTTP status separately from loopback 502', async (t) => {
  const logs = [];
  const { createStrictLidBroker } = brokerHarness(logs);
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100, dispatcher: null, releaseDelayMs: 0,
    fetchImpl: async () => new Response('secret upstream body', { status: 403 }),
  });
  t.after(() => broker.close());
  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 502);
  await response.json();
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0]);
  assert.equal(event.stage, 'headers');
  assert.equal(event.upstreamStatus, 403);
  assert.equal(event.errorCode, 'PROVIDER_REQUEST_FAILED');
  assert.doesNotMatch(logs.join(''), /secret|upstream body|provider\.invalid/);
});

test('strict LID accepts rotating query credentials only behind an unchanged strong file validator and target identity', async (t) => {
  const cases = [
    { name: 'same path and query shape, unchanged strong ETag', allowed: true },
    { name: 'missing validator', etag: null, allowed: false },
    { name: 'last-modified alone is not a strong validator', etag: null, modified: 'Wed, 09 Sep 2026 12:00:00 GMT', allowed: false },
    { name: 'changed ETag', changedEtag: true, allowed: false },
    { name: 'changed target path', changedPath: true, allowed: false },
    { name: 'changed target host', changedHost: true, allowed: false },
    { name: 'changed query shape', changedQueryShape: true, allowed: false },
  ];
  for (const fixture of cases) await t.test(fixture.name, async () => {
    const { createStrictLidBroker } = brokerHarness();
    let calls = 0;
    const broker = await createStrictLidBroker({
      sourceUrl: 'https://provider.invalid/movie/account/password/file.mkv',
      fileSizeBytes: 20, dispatcher: null, releaseDelayMs: 0,
      fetchImpl: async (_url, options) => {
        calls++;
        const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        const start = Number(startText), end = Number(endText);
        const etag = fixture.etag === null ? null : fixture.changedEtag && calls > 1 ? '"other-file"' : '"same-file"';
        const response = new Response(Buffer.alloc(end - start + 1, 7), { status: 206, headers: {
          'Content-Range': `bytes ${start}-${end}/20`, 'Content-Length': String(end - start + 1),
          ...(etag ? { ETag: etag } : {}), ...(fixture.modified ? { 'Last-Modified': fixture.modified } : {}),
        } });
        const host = fixture.changedHost && calls > 1 ? 'other.invalid' : 'cdn.invalid';
        const pathname = fixture.changedPath && calls > 1 ? '/other.mkv' : '/file.mkv';
        const query = fixture.changedQueryShape && calls > 1 ? `newToken=${calls}` : `token=${calls}`;
        return { status: response.status, headers: response.headers, body: response.body, url: `https://${host}${pathname}?${query}` };
      },
    });
    try {
      const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
      assert.equal(first.status, 206);
      assert.equal((await first.arrayBuffer()).byteLength, 10);
      const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=10-19' } });
      assert.equal(second.status, fixture.allowed ? 206 : 502);
      if (fixture.allowed) {
        assert.equal((await second.arrayBuffer()).byteLength, 10);
        assert.equal(broker.terminalError, null);
      } else {
        assert.equal((await second.json()).code, 'VOD_CHANGED');
      }
      assert.equal(calls, 2, 'No retry or additional provider request is introduced');
    } finally { await broker.close(); }
  });
});

test('strict LID resolves a rotating signed CDN path once and reuses that exact target without needing an ETag', async (t) => {
  let originRequests = 0;
  let rangeRequests = 0;
  const data = Buffer.alloc(64, 7);
  const provider = http.createServer((req, res) => {
    if (!req.url.startsWith('/signed/')) {
      originRequests++;
      res.writeHead(302, { Location: `/signed/ephemeral-${originRequests}/file.mkv` });
      res.end();
      return;
    }
    rangeRequests++;
    sendExactRange(req, res, data, { etag: false });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const { createStrictLidBroker } = brokerHarness();
  const broker = await createStrictLidBroker({ sourceUrl, fileSizeBytes: data.length, dispatcher: null, releaseDelayMs: 0 });
  t.after(() => broker.close());
  for (const [start, end] of [[0, 15], [48, 63], [16, 31]]) {
    const response = await fetch(broker.inputUrl, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(start, end + 1));
  }
  assert.equal(originRequests, 1, 'Do not mint a different temporary URL at every FFmpeg seek');
  assert.equal(rangeRequests, 3, 'No extra probe or retry is needed');
  assert.equal(broker.terminalError, null);
});

test('strict LID never re-resolves the provider entry when the pinned signed target expires', async (t) => {
  let originRequests = 0;
  let rangeRequests = 0;
  const data = Buffer.alloc(64, 7);
  const provider = http.createServer((req, res) => {
    if (!req.url.startsWith('/signed/')) {
      originRequests++;
      res.writeHead(302, { Location: `/signed/ephemeral-${originRequests}/file.mkv` });
      return res.end();
    }
    rangeRequests++;
    if (rangeRequests > 1) {
      res.writeHead(403);
      return res.end();
    }
    sendExactRange(req, res, data);
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const { createStrictLidBroker } = brokerHarness();
  const broker = await createStrictLidBroker({ sourceUrl, fileSizeBytes: data.length, dispatcher: null, releaseDelayMs: 0 });
  t.after(() => broker.close());
  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=48-63' } });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'PROVIDER_REQUEST_FAILED');
  }
  assert.equal(originRequests, 1);
  assert.equal(rangeRequests, 2, 'Expired signed targets stay terminal with no hidden reconnect');
});

test('finite playback reuses its validated signed target instead of resolving the entry per range', async (t) => {
  let originRequests = 0;
  const data = Buffer.alloc(64, 7);
  const provider = http.createServer((req, res) => {
    if (!req.url.startsWith('/signed/')) {
      originRequests++;
      res.writeHead(302, { Location: `/signed/ephemeral-${originRequests}/file.mkv` });
      return res.end();
    }
    sendExactRange(req, res, data);
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const { createStrictLidBroker } = brokerHarness();
  const broker = await createStrictLidBroker({ sourceUrl, fileSizeBytes: data.length,
    dispatcher: null, releaseDelayMs: 0, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 16 });
  t.after(() => broker.close());
  for (const [start, end] of [[0, 15], [48, 63]]) {
    const response = await fetch(broker.inputUrl, { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(start, end + 1));
  }
  assert.equal(originRequests, 1);
  assert.equal(broker.resolvedTargetReuses, 1);
  assert.equal(broker.providerRedirects, 1);
  assert.equal(broker.terminalError, null);
});

test('strict LID range parser converts only one bounded range into exact safe offsets', () => {
  const { parseStrictLidRange } = brokerHarness();
  assert.deepEqual({ ...parseStrictLidRange('bytes=5-', 20) }, { start: 5, end: 19, total: 20 });
  assert.deepEqual({ ...parseStrictLidRange('bytes=5-99', 20) }, { start: 5, end: 19, total: 20 });
  assert.deepEqual({ ...parseStrictLidRange('bytes=-4', 20) }, { start: 16, end: 19, total: 20 });
  for (const invalid of ['', 'bytes=-0', 'bytes=20-', 'bytes=9-2', 'bytes=0-1,4-5', 'items=0-1']) {
    assert.equal(parseStrictLidRange(invalid, 20), null, invalid);
  }
});

test('strict LID range deadline times out before the first byte with a fake clock', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  clock.advance(29_999);
  assert.equal(controller.signal.aborted, false);
  clock.advance(1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.timedOut, true);
  assert.equal(deadline.timeoutKind, 'first-byte');
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker maps the fake first-byte deadline to a closed 504', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      markFetchStarted();
      return new Promise((_resolve, reject) => {
        const fail = () => reject(options.signal.reason || new Error('aborted'));
        options.signal.addEventListener('abort', fail, { once: true });
        if (options.signal.aborted) fail();
      });
    },
  });
  t.after(() => broker.close());

  const responsePromise = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  await fetchStarted;
  clock.advance(29_999);
  assert.equal(broker.terminalError, null);
  clock.advance(1);
  const response = await responsePromise;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(broker.terminalError.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(clock.timers.size, 0);
});

test('strict LID range progress may exceed 30 s total while resetting only the idle deadline', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  deadline.progress();
  for (let index = 0; index < 4; index++) {
    clock.advance(10_000);
    deadline.progress();
  }
  assert.equal(clock.now, 40_000);
  assert.equal(controller.signal.aborted, false);
  assert.equal(deadline.timedOut, false);
  deadline.close();
  assert.equal(clock.timers.size, 0);
  clock.advance(60_000);
  assert.equal(controller.signal.aborted, false, 'cleanup must prevent a late timeout');
});

test('strict LID range deadline aborts a stalled body after the inactivity interval', () => {
  const { createStrictLidRangeDeadline } = brokerHarness();
  const clock = new FakeClock();
  const controller = new AbortController();
  const deadline = createStrictLidRangeDeadline({
    controller,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
  });

  deadline.progress();
  clock.advance(14_999);
  assert.equal(controller.signal.aborted, false);
  clock.advance(1);
  assert.equal(controller.signal.aborted, true);
  assert.equal(deadline.timeoutKind, 'idle');
  assert.equal(clock.timers.size, 0);
});

test('HTTP 200 busy-prefix stall preserves the fake first-byte timeout instead of RANGE_UNSUPPORTED', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      markFetchStarted();
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            try { controller.error(options.signal.reason || new Error('aborted')); } catch (_) {}
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    },
  });
  t.after(() => broker.close());

  const responsePromise = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  await fetchStarted;
  await new Promise((resolve) => setImmediate(resolve));
  clock.advance(30_000);
  const response = await responsePromise;
  assert.equal(response.status, 504);
  const payload = await response.json();
  assert.equal(payload.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.notEqual(payload.code, 'RANGE_UNSUPPORTED');
  assert.equal(broker.terminalError.code, 'PROVIDER_FIRST_BYTE_TIMEOUT');
  assert.equal(broker.providerFetches, 1);
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker maps a fake body stall to the idle timeout and drains it', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 10,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(0x2a));
          options.signal.addEventListener('abort', () => {
            try { controller.error(options.signal.reason || new Error('aborted')); } catch (_) {}
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-9/10',
          'Content-Length': '10',
          ETag: '"idle-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 206);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 1);
  const closedBody = reader.read().catch(() => null);
  clock.advance(14_999);
  assert.equal(broker.terminalError, null);
  clock.advance(1);
  for (let attempt = 0; attempt < 5 && !broker.terminalError; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(broker.terminalError.code, 'PROVIDER_IDLE_TIMEOUT');
  await closedBody;
  assert.equal(clock.timers.size, 0);
});

test('strict LID broker stays on loopback, answers HEAD locally, and forwards exact sticky ranges', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data);
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const local = new URL(broker.inputUrl);
  assert.equal(local.hostname, '127.0.0.1');
  assert.match(local.pathname, /^\/strict-lid\/[A-Za-z0-9_-]{40,}$/);
  assert.doesNotMatch(broker.inputUrl, /account|secret|file\.mkv/);

  const head = await fetch(broker.inputUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(data.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(calls.length, 0, 'local HEAD must consume zero provider sockets');

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=3-9' } });
  assert.equal(first.status, 206);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), data.subarray(3, 10));
  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=-5' } });
  assert.equal(second.status, 206);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), data.subarray(data.length - 5));
  assert.deepEqual(calls, [
    { range: 'bytes=3-9', ifRange: null },
    { range: `bytes=${data.length - 5}-${data.length - 1}`, ifRange: '"fixture-v1"' },
  ]);
});

test('strict LID freezes one sticky provider dispatcher for every sequential range', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(20, 0x41);
  const stickyDispatcher = { slot: 3 };
  const observedDispatchers = [];
  const observedConnections = [];
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    dispatcher: stickyDispatcher,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      observedDispatchers.push(options.dispatcher);
      observedConnections.push(options.headers.Connection);
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = data.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(body.length),
          ETag: '"sticky-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  for (const range of ['bytes=0-4', 'bytes=5-9']) {
    const response = await fetch(broker.inputUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    await response.arrayBuffer();
  }
  assert.equal(observedDispatchers.length, 2);
  assert.equal(observedDispatchers[0], stickyDispatcher);
  assert.equal(observedDispatchers[1], stickyDispatcher);
  assert.deepEqual(observedConnections, ['close', 'close']);
});

test('finite MKV seek reuses one provider connection across serialized windows', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const { Agent } = require('undici');
  const data = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
  const providerPorts = [];
  const connectionHeaders = [];
  const providerIdentities = [];
  const provider = http.createServer((req, res) => {
    providerPorts.push(req.socket.remotePort);
    connectionHeaders.push(req.headers.connection || null);
    sendExactRange(req, res, data, { etag: '"reuse-v1"' });
  });
  const sourceUrl = await listen(provider);
  const dispatcher = new Agent({ connections: 1, pipelining: 1 });
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 16,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
    onProviderIdentity: (identity) => providerIdentities.push(identity),
  });
  t.after(async () => {
    await broker.close();
    await dispatcher.close();
    await closeServer(provider);
  });

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  assert.equal(providerPorts.length, 2);
  assert.equal(new Set(providerPorts).size, 1, 'both windows must share one provider TCP connection');
  assert.deepEqual(connectionHeaders, ['keep-alive', 'keep-alive']);
  assert.equal(broker.providerFetches, 2);
  assert.equal(broker.completedProviderFetches, 2);
  assert.equal(providerIdentities.length, 1, 'provider identity is bound once on the first exact window');
  assert.deepEqual({ ...providerIdentities[0].validator }, {
    header: 'If-Range',
    value: '"reuse-v1"',
    kind: 'etag',
  });
  assert.match(providerIdentities[0].effectiveUrlSha256, /^[a-f0-9]{64}$/);
  assert.match(providerIdentities[0].effectiveUrlIdentitySha256, /^[a-f0-9]{64}$/);
});

test('finite seek broker renews an ageing dispatcher on the same pinned proxy slot', async () => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
  const observedDispatchers = [];
  const closedGenerations = [];
  let generation = 0;
  let nowMs = 0;
  const dispatcherFactory = () => {
    const dispatcher = {
      slot: 3,
      generation: ++generation,
      async close() { closedGenerations.push(this.generation); },
    };
    return dispatcher;
  };
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 16,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    dispatcherFactory,
    dispatcherMaxAgeMs: 5,
    now: () => nowMs,
    fetchImpl: async (_url, options) => {
      observedDispatchers.push(options.dispatcher);
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = data.subarray(start, end + 1);
      nowMs += 10;
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(body.length),
          ETag: '"renew-v1"',
        },
      });
    },
  });

  try {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    assert.deepEqual(observedDispatchers.map((dispatcher) => dispatcher.slot), [3, 3]);
    assert.deepEqual(observedDispatchers.map((dispatcher) => dispatcher.generation), [1, 2]);
    assert.deepEqual(closedGenerations, [1]);
    assert.equal(broker.dispatcherRefreshes, 1);
  } finally {
    await broker.close();
  }
  assert.deepEqual(closedGenerations, [1, 2]);
});

test('finite seek broker replaces a failed tunnel before retrying remaining bytes', async () => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(8, 0x6a);
  const observedDispatchers = [];
  const closedGenerations = [];
  let generation = 0;
  let calls = 0;
  const dispatcherFactory = () => ({
    slot: 4,
    generation: ++generation,
    async close() { closedGenerations.push(this.generation); },
  });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 8,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    dispatcherFactory,
    fetchImpl: async (_url, options) => {
      calls += 1;
      observedDispatchers.push(options.dispatcher);
      if (calls === 1) throw new Error('proxy tunnel reset');
      return new Response(data, {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-7/${data.length}`,
          'Content-Length': String(data.length),
          ETag: '"retry-v1"',
        },
      });
    },
  });

  try {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    assert.deepEqual(observedDispatchers.map((dispatcher) => dispatcher.slot), [4, 4]);
    assert.deepEqual(observedDispatchers.map((dispatcher) => dispatcher.generation), [1, 2]);
    assert.deepEqual(closedGenerations, [1]);
    assert.equal(broker.interruptedProviderFetches, 1);
    assert.equal(broker.completedProviderFetches, 1);
    assert.equal(broker.dispatcherRefreshes, 1);
  } finally {
    await broker.close();
  }
  assert.deepEqual(closedGenerations, [1, 2]);
});

test('finite seek broker falls back HTTP to SOCKS5 on the same proxy slot before retrying', async () => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(8, 0x5b);
  const events = [];
  const observedDispatchers = [];
  const primaryFactory = () => ({
    slot: 2,
    nodeTransport: 'http',
    async close() { events.push('close-http'); },
  });
  const fallbackFactory = () => ({
    slot: 2,
    nodeTransport: 'socks5',
    async close() { events.push('close-socks5'); },
  });
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 8,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    dispatcherFactory: primaryFactory,
    dispatcherFallbackFactory: fallbackFactory,
    onDispatcherFallback: ({ code }) => events.push(`fallback-${code}`),
    fetchImpl: async (_url, options) => {
      observedDispatchers.push(options.dispatcher);
      if (options.dispatcher.nodeTransport === 'http') {
        throw Object.assign(new Error('HTTP CONNECT path reset'), { code: 'ECONNRESET' });
      }
      assert.deepEqual(events, ['close-http', 'fallback-PROVIDER_FETCH_FAILED']);
      return new Response(data, {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-7/${data.length}`,
          'Content-Length': String(data.length),
          ETag: '"same-exit-fallback-v1"',
        },
      });
    },
  });

  try {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    assert.deepEqual(observedDispatchers.map((dispatcher) => ({
      slot: dispatcher.slot,
      nodeTransport: dispatcher.nodeTransport,
    })), [
      { slot: 2, nodeTransport: 'http' },
      { slot: 2, nodeTransport: 'socks5' },
    ]);
    assert.equal(broker.interruptedProviderFetches, 1);
    assert.equal(broker.completedProviderFetches, 1);
    assert.equal(broker.dispatcherRefreshes, 1);
    assert.equal(broker.dispatcherFallbacks, 1);
  } finally {
    await broker.close();
  }
  assert.deepEqual(events, [
    'close-http',
    'fallback-PROVIDER_FETCH_FAILED',
    'close-socks5',
  ]);
});

test('finite seek broker does not change transport after an upstream HTTP response', async () => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(8, 0x4a);
  const transports = [];
  let primaryGeneration = 0;
  let fallbackFactoryCalls = 0;
  let fetchCalls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 8,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    dispatcherFactory: () => ({
      slot: 2,
      nodeTransport: 'http',
      generation: ++primaryGeneration,
      async close() {},
    }),
    dispatcherFallbackFactory: () => {
      fallbackFactoryCalls += 1;
      return { slot: 2, nodeTransport: 'socks5', async close() {} };
    },
    fetchImpl: async (_url, options) => {
      fetchCalls += 1;
      transports.push(options.dispatcher.nodeTransport);
      if (fetchCalls === 1) return new Response('temporary', { status: 503 });
      return new Response(data, {
        status: 206,
        headers: {
          'Content-Range': `bytes 0-7/${data.length}`,
          'Content-Length': String(data.length),
          ETag: '"http-response-v1"',
        },
      });
    },
  });

  try {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    assert.deepEqual(transports, ['http', 'http']);
    assert.equal(fallbackFactoryCalls, 0);
    assert.equal(broker.dispatcherFallbacks, 0);
    assert.equal(broker.dispatcherRefreshes, 1);
  } finally {
    await broker.close();
  }
});

test('strict broker can reopen immediately only after an exact provider range is fully drained', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(64, 0x5c);
  const openedAt = [];
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 500,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      openedAt.push(Date.now());
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = data.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(body.length),
          ETag: '"drained-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  for (const range of ['bytes=0-15', 'bytes=16-31']) {
    const response = await fetch(broker.inputUrl, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 16);
  }

  assert.equal(openedAt.length, 2);
  assert.ok(openedAt[1] - openedAt[0] < 400,
    `fully drained successor waited ${openedAt[1] - openedAt[0]}ms`);
  assert.equal(broker.completedProviderFetches, 2);
  assert.equal(broker.interruptedProviderFetches, 0);
});

test('strict LID broker preempts an old local range, awaits close, and never exceeds one provider socket', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(256, 0x5a);
  // The provider's loopback `close` event can trail the client-side Undici
  // drain acknowledgement by a few scheduler ticks. Keep a deliberately wide
  // test-only grace so this integration assertion proves a substantial
  // post-close cooldown without depending on sub-10 ms runner timing.
  const releaseDelayMs = 200;
  const minimumObservedPostCloseDelayMs = 100;
  const state = { active: 0, maxActive: 0, calls: 0, firstClosedAt: 0, secondOpenedAt: 0 };
  const provider = http.createServer((req, res) => {
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    if (state.calls === 2) state.secondOpenedAt = Date.now();
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      state.active--;
      if (state.calls === 1) state.firstClosedAt = Date.now();
    };
    res.once('close', release);
    res.once('finish', release);
    const { start, end } = exactRange(req, data.length);
    const length = end - start + 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(length),
      ETag: '"serial-v1"',
    });
    if (state.calls === 1) {
      res.write(data.subarray(start, start + 1));
      return;
    }
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-127' } });
  assert.equal(first.status, 206);
  const firstReader = first.body.getReader();
  const firstChunk = await firstReader.read();
  assert.equal(firstChunk.value.length, 1);

  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=128-255' } });
  assert.equal(second.status, 206);
  assert.equal((await second.arrayBuffer()).byteLength, 128);
  await firstReader.cancel().catch(() => {});

  assert.equal(state.calls, 2);
  assert.equal(state.maxActive, 1, 'strict LID must never overlap provider bodies');
  assert.ok(state.firstClosedAt > 0 && state.secondOpenedAt >= state.firstClosedAt);
  assert.ok(
    state.secondOpenedAt - state.firstClosedAt >= minimumObservedPostCloseDelayMs,
    `successor opened only ${state.secondOpenedAt - state.firstClosedAt}ms after close`,
  );
});

test('finite seek broker preserves every continuous local range across serial provider windows', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const state = { active: 0, maxActive: 0, calls: [], firstResponse: null };
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const provider = http.createServer((req, res) => {
    const { start, end } = exactRange(req, data.length);
    state.calls.push(req.headers.range);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      state.active--;
    };
    res.once('close', release);
    res.once('finish', release);
    const length = end - start + 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(length),
      ETag: '"finite-serial-v1"',
    });
    if (state.calls.length === 1) {
      state.firstResponse = { res, body: data.subarray(start, end + 1) };
      markFirstStarted();
      return;
    }
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    supersededReleaseDelayMs: 200,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const firstPending = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-31' } })
    .then(async (response) => ({ response, body: Buffer.from(await response.arrayBuffer()) }))
    .catch((error) => ({ error }));
  await firstStarted;
  const secondPending = fetch(broker.inputUrl, { headers: { Range: 'bytes=16-31' } });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(state.calls, ['bytes=0-7']);
  assert.equal(state.active, 1);
  state.firstResponse.res.end(state.firstResponse.body);

  const [firstOutcome, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(firstOutcome.error, undefined);
  assert.equal(firstOutcome.response.status, 206);
  assert.equal(firstOutcome.response.headers.get('content-range'), 'bytes 0-31/64');
  assert.equal(firstOutcome.response.headers.get('content-length'), '32');
  assert.deepEqual(firstOutcome.body, data.subarray(0, 32));
  assert.equal(second.status, 206);
  assert.equal(second.headers.get('content-range'), 'bytes 16-31/64');
  assert.equal(second.headers.get('content-length'), '16');
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), data.subarray(16, 32));
  assert.deepEqual(state.calls, ['bytes=0-7', 'bytes=16-23', 'bytes=8-15', 'bytes=24-31']);
  assert.equal(state.maxActive, 1, 'finite windows must never overlap provider bodies');
  assert.equal(state.active, 0);
  assert.equal(broker.completedProviderFetches, 4);
  assert.equal(broker.interruptedProviderFetches, 0);
  assert.ok(broker.maxQueuedRequests >= 2);
  assert.ok(broker.maxQueuedProviderWindows >= 2);

  const cached = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-31' } });
  assert.equal(cached.status, 206);
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), data.subarray(0, 32));
  assert.deepEqual(state.calls, ['bytes=0-7', 'bytes=16-23', 'bytes=8-15', 'bytes=24-31']);
  assert.equal(broker.completedProviderFetches, 4);
  assert.ok(broker.cacheHits >= 5, 'queued overlapping windows must be coalesced from cache');
  assert.equal(broker.cacheMisses, 5);
});

test('finite seek broker aligns the first slice so an overlapping cue fetches only its missing tail', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push(req.headers.range);
    sendExactRange(req, res, data, { etag: '"finite-aligned-v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteSequentialWindowBytes: 24,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const prefix = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } });
  assert.deepEqual(Buffer.from(await prefix.arrayBuffer()), data.subarray(0, 8));
  const overlap = await fetch(broker.inputUrl, { headers: { Range: 'bytes=2-15' } });
  assert.deepEqual(Buffer.from(await overlap.arrayBuffer()), data.subarray(2, 16));
  assert.deepEqual(calls, ['bytes=0-7', 'bytes=8-15']);
  assert.equal(broker.cacheHits, 1);
});

test('finite seek broker expands only a proven sequential local read after its first provider window', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push(req.headers.range);
    sendExactRange(req, res, data, { etag: '"finite-sequential-v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteSequentialWindowBytes: 24,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-39' } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(0, 40));
  assert.deepEqual(calls, ['bytes=0-7', 'bytes=8-31', 'bytes=32-39']);
  assert.equal(broker.sequentialWindowBytes, 24);
  assert.equal(broker.completedProviderFetches, 3);
});

test('finite seek broker primes one pinned route before its base and sequential windows', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push(req.headers.range);
    sendExactRange(req, res, data, { etag: '"finite-warmup-v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWarmupWindowBytes: 2,
    finiteWindowBytes: 8,
    finiteSequentialWindowBytes: 24,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-39' } });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(0, 40));
  assert.deepEqual(calls, ['bytes=0-1', 'bytes=2-7', 'bytes=8-31', 'bytes=32-39']);
  assert.equal(broker.warmupWindowBytes, 2);
  assert.equal(broker.warmupProviderWindows, 1);
  assert.equal(broker.completedProviderFetches, 4);
});

test('a validated resume reuses the previously materialized MKV prefix after one current warmup', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push(req.headers.range);
    sendExactRange(req, res, data, { etag: '"finite-resume-prefix-v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  let candidate = null;
  const common = {
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWarmupWindowBytes: 2,
    finiteWindowBytes: 8,
    finiteSequentialWindowBytes: 24,
    finiteResumePrefixTargetBytes: 8,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  };

  const first = await createStrictLidBroker({
    ...common,
    onFiniteResumePrefix: (prefix) => {
      candidate = { ...prefix, payload: Buffer.from(prefix.payload) };
      return true;
    },
  });
  const firstResponse = await fetch(first.inputUrl, { headers: { Range: 'bytes=0-7' } });
  assert.deepEqual(Buffer.from(await firstResponse.arrayBuffer()), data.subarray(0, 8));
  assert.deepEqual(calls, ['bytes=0-1', 'bytes=2-7']);
  assert.ok(candidate);
  assert.equal(first.resumePrefixPublished, true);
  await first.close();

  const second = await createStrictLidBroker({
    ...common,
    finiteResumePrefixCandidate: candidate,
  });
  t.after(() => second.close());
  const secondResponse = await fetch(second.inputUrl, { headers: { Range: 'bytes=0-7' } });
  assert.deepEqual(Buffer.from(await secondResponse.arrayBuffer()), data.subarray(0, 8));
  assert.deepEqual(calls, ['bytes=0-1', 'bytes=2-7', 'bytes=0-1']);
  assert.equal(second.providerFetches, 1);
  assert.equal(second.completedProviderFetches, 1);
  assert.equal(second.interruptedProviderFetches, 0);
  assert.equal(second.resumePrefixCacheHit, true);
  assert.equal(second.resumePrefixCacheBytes, 8);
  await second.close();

  const stale = await createStrictLidBroker({
    ...common,
    finiteResumePrefixCandidate: {
      ...candidate,
      validator: { ...candidate.validator, value: '"finite-resume-prefix-stale"' },
    },
  });
  t.after(() => stale.close());
  const staleResponse = await fetch(stale.inputUrl, { headers: { Range: 'bytes=0-7' } });
  assert.deepEqual(Buffer.from(await staleResponse.arrayBuffer()), data.subarray(0, 8));
  assert.deepEqual(calls, [
    'bytes=0-1',
    'bytes=2-7',
    'bytes=0-1',
    'bytes=0-1',
    'bytes=2-7',
  ]);
  assert.equal(stale.resumePrefixCacheHit, false);
  await stale.close();

  const weak = await createStrictLidBroker({
    ...common,
    finiteResumePrefixWeakValidationBytes: 4,
    finiteResumePrefixCandidate: {
      ...candidate,
      validator: null,
      effectiveUrlIdentitySha256: 'b'.repeat(64),
    },
  });
  t.after(() => weak.close());
  const weakResponse = await fetch(weak.inputUrl, { headers: { Range: 'bytes=0-7' } });
  assert.deepEqual(Buffer.from(await weakResponse.arrayBuffer()), data.subarray(0, 8));
  assert.deepEqual(calls.slice(-1), ['bytes=0-3']);
  assert.equal(weak.warmupWindowBytes, 4);
  assert.equal(weak.resumePrefixCacheHit, true);
  assert.equal(weak.resumePrefixCacheBytes, 8);
});

test('a newer cue prevents the primed header request from cooling its pinned tunnel', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const calls = [];
  let releaseWarmupTail;
  const warmupTailGate = new Promise((resolve) => { releaseWarmupTail = resolve; });
  t.after(() => releaseWarmupTail());
  const provider = http.createServer(async (req, res) => {
    calls.push(req.headers.range);
    if (req.headers.range === 'bytes=0-1') {
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 0-1/${data.length}`,
        'Content-Length': '2',
        ETag: '"finite-warmup-cue-v1"',
      });
      res.write(data.subarray(0, 1));
      await warmupTailGate;
      res.end(data.subarray(1, 2));
      return;
    }
    sendExactRange(req, res, data, { etag: '"finite-warmup-cue-v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWarmupWindowBytes: 2,
    finiteWarmupCueGraceMs: 50,
    finiteWindowBytes: 8,
    finiteSequentialWindowBytes: 24,
    finiteCacheBytes: 64,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    supersededReleaseDelayMs: 20,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const header = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-39' } });
  const headerReader = header.body.getReader();
  const primer = await headerReader.read();
  assert.deepEqual(Buffer.from(primer.value), data.subarray(0, 1));

  const cueBodyPromise = new Promise((resolve, reject) => {
    const request = http.get(broker.inputUrl, {
      agent: false,
      headers: { Range: 'bytes=62-63' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  for (let attempt = 0; attempt < 100 && broker.maxQueuedRequests < 2; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(broker.maxQueuedRequests, 2);
  releaseWarmupTail();
  const cueBody = await cueBodyPromise;
  assert.deepEqual(cueBody, data.subarray(62, 64));
  await headerReader.cancel().catch(() => {});

  assert.deepEqual(calls, ['bytes=0-1', 'bytes=62-63']);
  assert.equal(broker.completedProviderFetches, 2);
  assert.equal(broker.interruptedProviderFetches, 0);
});

test('finite seek broker streams provider progress before a window is fully materialized', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 16 }, (_, index) => 0x40 + index));
  let releaseProviderTail;
  const providerTailGate = new Promise((resolve) => { releaseProviderTail = resolve; });
  let markProviderPrefix;
  const providerPrefixSent = new Promise((resolve) => { markProviderPrefix = resolve; });
  const provider = http.createServer(async (req, res) => {
    const { start, end } = exactRange(req, data.length);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(end - start + 1),
      ETag: '"finite-stream-v1"',
    });
    res.write(data.subarray(start, start + 4));
    markProviderPrefix();
    await providerTailGate;
    res.end(data.subarray(start + 4, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 16,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const localResponsePending = fetch(broker.inputUrl, { headers: { Range: 'bytes=0-7' } });
  await providerPrefixSent;
  const localResponse = await Promise.race([
    localResponsePending,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('broker withheld the provider prefix until the full window completed')),
      500,
    )),
  ]);
  assert.equal(localResponse.status, 206);
  assert.equal(localResponse.headers.get('content-length'), '8');
  const reader = localResponse.body.getReader();
  const prefix = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('broker did not stream provider progress to the local reader')),
      500,
    )),
  ]);
  assert.deepEqual(Buffer.from(prefix.value), data.subarray(0, 4));

  releaseProviderTail();
  const chunks = [Buffer.from(prefix.value)];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  assert.deepEqual(Buffer.concat(chunks), data.subarray(0, 8));
  assert.equal(broker.completedProviderFetches, 1);
});

test('finite seek broker preempts only a locally abandoned cue before serving its successor', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const state = { active: 0, maxActive: 0, calls: [] };
  const provider = http.createServer((req, res) => {
    const { start, end } = exactRange(req, data.length);
    state.calls.push(req.headers.range);
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active--;
    };
    res.once('close', release);
    res.once('finish', release);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(end - start + 1),
      ETag: '"finite-abandon-v1"',
    });
    if (state.calls.length === 1) {
      res.write(data.subarray(start, start + 1));
      return;
    }
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: 8,
    finiteCacheBytes: 32,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    supersededReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  let abandonFirst;
  const firstAbandoned = new Promise((resolve, reject) => {
    const request = http.get(broker.inputUrl, { headers: { Range: 'bytes=0-31' } }, (response) => {
      response.once('data', () => {
        response.destroy();
        request.destroy();
        resolve();
      });
      response.once('error', () => {});
    });
    request.once('error', (error) => {
      if (state.calls.length === 0) reject(error);
    });
    abandonFirst = request;
  });
  t.after(() => abandonFirst?.destroy());
  await firstAbandoned;

  const second = await Promise.race([
    fetch(broker.inputUrl, { headers: { Range: 'bytes=32-39' } }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('abandoned finite cue kept the provider slot')),
      2000,
    )),
  ]);
  assert.equal(second.status, 206);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), data.subarray(32, 40));
  assert.deepEqual(state.calls, ['bytes=0-7', 'bytes=32-39']);
  assert.equal(state.maxActive, 1, 'the successor must wait for the abandoned provider body to close');
  assert.equal(state.active, 0);
  assert.equal(broker.interruptedProviderFetches, 1);
  assert.equal(broker.completedProviderFetches, 1);
  assert.equal(broker.plannedSupersessions, 1);
  assert.deepEqual(
    Array.from(broker.windowTrace, (entry) => ({
      providerStart: entry.providerStart,
      providerEnd: entry.providerEnd,
      bytes: entry.bytes,
      outcome: entry.outcome,
    })),
    [
      { providerStart: 0, providerEnd: 7, bytes: 1, outcome: 'superseded' },
      { providerStart: 32, providerEnd: 39, bytes: 8, outcome: 'completed' },
    ],
  );
});

test('finite seek broker serves a newer cue while an older local response is backpressured', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const MiB = 1024 * 1024;
  const data = Buffer.alloc(17 * MiB);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  const state = { active: 0, maxActive: 0, calls: 0 };
  const provider = http.createServer((req, res) => {
    const { start, end } = exactRange(req, data.length);
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      state.active--;
    };
    res.once('close', release);
    res.once('finish', release);
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(end - start + 1),
      ETag: '"finite-backpressure-v1"',
    });
    res.end(data.subarray(start, end + 1));
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    finiteWindowBytes: MiB,
    finiteCacheBytes: 4 * MiB,
    releaseDelayMs: 0,
    completedReleaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  let firstResponse;
  let resolveFirstResponse;
  const firstResponseReady = new Promise((resolve) => { resolveFirstResponse = resolve; });
  const firstRequest = http.get(broker.inputUrl, {
    headers: { Range: `bytes=0-${16 * MiB - 1}` },
  }, (response) => {
    firstResponse = response;
    response.pause();
    resolveFirstResponse();
  });
  t.after(() => firstRequest.destroy());
  await firstResponseReady;

  const secondBody = await Promise.race([
    fetch(broker.inputUrl, {
      headers: { Range: `bytes=${16 * MiB}-${17 * MiB - 1}` },
    }).then(async (response) => {
      assert.equal(response.status, 206);
      return Buffer.from(await response.arrayBuffer());
    }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('newer cue was blocked by an older local response')),
      3000,
    )),
  ]);
  assert.deepEqual(secondBody, data.subarray(16 * MiB));

  const firstChunks = [];
  firstResponse.on('data', (chunk) => firstChunks.push(Buffer.from(chunk)));
  const firstComplete = new Promise((resolve, reject) => {
    firstResponse.once('end', resolve);
    firstResponse.once('error', reject);
  });
  firstResponse.resume();
  await firstComplete;
  assert.deepEqual(Buffer.concat(firstChunks), data.subarray(0, 16 * MiB));
  assert.equal(state.maxActive, 1, 'provider bodies remain strictly serialized');
  assert.equal(state.active, 0);
  assert.ok(state.calls >= 17);
  assert.ok(broker.maxQueuedProviderWindows >= 1);
});

for (const fixture of [
  {
    name: 'first HTTP 458',
    response(_req, res) { res.writeHead(458, { 'Content-Type': 'text/plain' }); res.end('busy'); },
    upstreamStatus: 458,
  },
  {
    name: 'first HTTP 200 textual provider-busy body',
    response(_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '45' });
      res.end('user_multi_ip maximum connections provider busy');
    },
    upstreamStatus: 200,
  },
]) {
  test(`strict LID treats ${fixture.name} as terminal after one fetch`, async (t) => {
    const { createStrictLidBroker } = brokerHarness();
    let calls = 0;
    const provider = http.createServer((req, res) => { calls++; fixture.response(req, res); });
    const sourceUrl = await listen(provider);
    t.after(() => closeServer(provider));
    const broker = await createStrictLidBroker({
      sourceUrl,
      fileSizeBytes: 100,
      dispatcher: null,
      releaseDelayMs: 0,
      openTimeoutMs: 2000,
    });
    t.after(() => broker.close());

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
      assert.equal(response.status, 458);
      const payload = await response.json();
      assert.equal(payload.code, 'PROVIDER_BUSY');
      assert.equal(payload.upstreamStatus, fixture.upstreamStatus);
    }
    assert.equal(calls, 1);
    assert.equal(broker.providerFetches, 1);
    assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  });
}

test('first HTTP 458 remains terminal when fake range deadlines advance afterwards', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const clock = new FakeClock();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    firstByteTimeoutMs: 30_000,
    idleTimeoutMs: 15_000,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    fetchImpl: async () => {
      calls++;
      return new Response('provider busy', { status: 458 });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(response.status, 458);
  assert.equal((await response.json()).code, 'PROVIDER_BUSY');
  assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  assert.equal(clock.timers.size, 0, 'terminal cleanup must clear the range deadline');
  clock.advance(60_000);
  assert.equal(broker.terminalError.code, 'PROVIDER_BUSY');
  assert.equal(calls, 1);
});

test('strict LID keeps proxy HTTP 407 distinct from provider-busy and never retries it', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const provider = http.createServer((_req, res) => {
    calls++;
    res.writeHead(407, { 'Content-Type': 'text/plain' });
    res.end('proxy authentication required');
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'PROXY_AUTH_FAILED');
    assert.equal(payload.upstreamStatus, 407);
    assert.notEqual(payload.code, 'PROVIDER_BUSY');
  }
  assert.equal(calls, 1);
  assert.equal(broker.providerFetches, 1);
});

test('strict LID preserves a proxy CONNECT 407 that undici reports as a thrown failure', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.invalid/movie/account/secret/file.mkv',
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    fetchImpl: async () => {
      calls++;
      const error = new Error('Proxy response 407 authentication required');
      error.code = 'PROXY_AUTH_FAILED';
      throw error;
    },
  });
  t.after(() => broker.close());

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(response.status, 502);
    const payload = await response.json();
    assert.equal(payload.code, 'PROXY_AUTH_FAILED');
    assert.equal(payload.upstreamStatus, 407);
  }
  assert.equal(calls, 1);
});

test('strict LID fails closed on status/range/length/encoding validation defects', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x2a);
  const cases = [
    {
      name: 'status',
      send(req, res) {
        exactRange(req, data.length);
        res.writeHead(204);
        res.end();
      },
      code: 'PROVIDER_REQUEST_FAILED',
    },
    {
      name: 'content-range',
      send(req, res) { sendExactRange(req, res, data, { contentRange: 'bytes 0-8/32' }); },
      code: 'RANGE_UNSUPPORTED',
    },
    {
      name: 'content-length',
      send(req, res) { sendExactRange(req, res, data, { contentLength: 9, body: data.subarray(0, 9) }); },
      code: 'RANGE_UNSUPPORTED',
    },
    {
      name: 'content-encoding',
      send(req, res) { sendExactRange(req, res, data, { contentEncoding: 'gzip' }); },
      code: 'RANGE_UNSUPPORTED',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const provider = http.createServer((req, res) => { calls++; fixture.send(req, res); });
      const sourceUrl = await listen(provider);
      const broker = await createStrictLidBroker({
        sourceUrl,
        fileSizeBytes: data.length,
        dispatcher: null,
        releaseDelayMs: 0,
        openTimeoutMs: 2000,
      });
      try {
        const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
        assert.equal(response.status, 502);
        assert.equal((await response.json()).code, fixture.code);
        assert.equal(calls, 1);
      } finally {
        await broker.close();
        await closeServer(provider);
      }
    });
  }
});

test('strict LID pins the first strong validator and fails closed if the file changes', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x33);
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data, { etag: calls.length === 1 ? '"v1"' : '"v2"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
  });
  t.after(() => broker.close());

  const first = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(first.status, 206);
  await first.arrayBuffer();
  const second = await fetch(broker.inputUrl, { headers: { Range: 'bytes=10-19' } });
  assert.equal(second.status, 502);
  assert.equal((await second.json()).code, 'VOD_CHANGED');
  assert.equal(calls[1].ifRange, '"v1"');
});

test('finite MKV seek broker pins the preopen validator before forwarding bytes', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.alloc(32, 0x44);
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ifRange: req.headers['if-range'] || null });
    sendExactRange(req, res, data, { etag: '"v1"' });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));

  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    expectedValidator: { header: 'If-Range', value: '"v1"', kind: 'etag' },
    effectiveUrlSha256: require('node:crypto').createHash('sha256').update(sourceUrl).digest('hex'),
  });
  t.after(() => broker.close());
  assert.match(new URL(broker.inputUrl).pathname, /^\/finite-mkv-seek\/[A-Za-z0-9_-]{40,}$/);

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=4-11' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(4, 12));
  assert.deepEqual(calls, [{ range: 'bytes=4-11', ifRange: '"v1"' }]);

});

test('finite MKV seek follows rotating CDN targets while exact ranges and validators stay pinned', async (t) => {
  const { createStrictLidBroker, strictLidEffectiveUrlIdentitySha256 } = brokerHarness();
  const data = Buffer.alloc(32, 0x45);
  const initialUrl = 'https://cdn.example/media/title.mkv?expires=100&signature=old';
  const rotatedUrl = 'https://cdn.example/media/title.mkv?signature=new&expires=200';
  const changedPathUrl = 'https://cdn.example/media/other-title.mkv?expires=200&signature=new';
  const expectedFullHash = require('node:crypto').createHash('sha256').update(initialUrl).digest('hex');
  const expectedIdentityHash = strictLidEffectiveUrlIdentitySha256(initialUrl);

  assert.equal(expectedIdentityHash, strictLidEffectiveUrlIdentitySha256(rotatedUrl));
  assert.notEqual(expectedIdentityHash, strictLidEffectiveUrlIdentitySha256(changedPathUrl));

  const responseFor = (url, range = { start: 4, end: 11 }) => {
    const body = data.subarray(range.start, range.end + 1);
    const response = new Response(body, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${range.start}-${range.end}/${data.length}`,
        'Content-Length': String(body.length),
      },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };

  const compatible = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    effectiveUrlSha256: expectedFullHash,
    effectiveUrlIdentitySha256: expectedIdentityHash,
    fetchImpl: async () => responseFor(rotatedUrl),
  });
  t.after(() => compatible.close());
  const accepted = await fetch(compatible.inputUrl, { headers: { Range: 'bytes=4-11' } });
  assert.equal(accepted.status, 206);
  assert.deepEqual(Buffer.from(await accepted.arrayBuffer()), data.subarray(4, 12));

  const changedTarget = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    effectiveUrlSha256: expectedFullHash,
    effectiveUrlIdentitySha256: expectedIdentityHash,
    fetchImpl: async () => responseFor(changedPathUrl),
  });
  try {
    const acceptedRedirect = await fetch(changedTarget.inputUrl, { headers: { Range: 'bytes=4-11' } });
    assert.equal(acceptedRedirect.status, 206);
    assert.deepEqual(Buffer.from(await acceptedRedirect.arrayBuffer()), data.subarray(4, 12));
  } finally {
    await changedTarget.close();
  }

  const strictLanguage = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'strict-lid',
    effectiveUrlSha256: expectedFullHash,
    effectiveUrlIdentitySha256: expectedIdentityHash,
    fetchImpl: async () => responseFor(rotatedUrl),
  });
  try {
    const rejected = await fetch(strictLanguage.inputUrl, { headers: { Range: 'bytes=4-11' } });
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'VOD_CHANGED');
  } finally {
    await strictLanguage.close();
  }

  const changedValidator = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    effectiveUrlSha256: expectedFullHash,
    effectiveUrlIdentitySha256: expectedIdentityHash,
    expectedValidator: { header: 'If-Range', value: '"v1"', kind: 'etag' },
    fetchImpl: async () => {
      const response = responseFor(changedPathUrl);
      response.headers.set('ETag', '"v2"');
      return response;
    },
  });
  try {
    const rejected = await fetch(changedValidator.inputUrl, { headers: { Range: 'bytes=4-11' } });
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'VOD_CHANGED');
  } finally {
    await changedValidator.close();
  }

  const changedSize = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    releaseDelayMs: 0,
    openTimeoutMs: 2000,
    pathPrefix: 'finite-mkv-seek',
    effectiveUrlSha256: expectedFullHash,
    effectiveUrlIdentitySha256: expectedIdentityHash,
    fetchImpl: async () => {
      const response = responseFor(changedPathUrl);
      response.headers.set('Content-Range', `bytes 4-11/${data.length + 1}`);
      return response;
    },
  });
  try {
    const rejected = await fetch(changedSize.inputUrl, { headers: { Range: 'bytes=4-11' } });
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json()).code, 'RANGE_UNSUPPORTED');
  } finally {
    await changedSize.close();
  }

});

test('finite MKV seek transparently resumes short declared ranges without overlapping provider sockets', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 40 }, (_, index) => index));
  const calls = [];
  const tracker = { active: 0, maxActive: 0 };
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    releaseDelayMs: 0,
    finiteMaxReconnects: 16,
    fetchImpl: async (_url, options) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      calls.push(options.headers.Range);
      tracker.active++;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      let emitted = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        tracker.active--;
      };
      const body = new ReadableStream({
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(data.subarray(start, Math.min(end + 1, start + 4)));
            return;
          }
          release();
          controller.close();
        },
        cancel() { release(); },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(end - start + 1),
          ETag: '"short-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-39' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  assert.equal(tracker.maxActive, 1);
  assert.equal(tracker.active, 0);
  assert.deepEqual(calls, Array.from({ length: 10 }, (_, index) => `bytes=${index * 4}-39`));
  assert.equal(broker.providerFetches, 10);
  assert.equal(broker.completedProviderFetches, 1);
  assert.equal(broker.interruptedProviderFetches, 9);
});

test('finite MKV seek resumes from the exact byte after an upstream reader error', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 24 }, (_, index) => 0x60 + index));
  const calls = [];
  const tracker = { active: 0, maxActive: 0 };
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    releaseDelayMs: 0,
    finiteMaxReconnects: 16,
    fetchImpl: async (_url, options) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      calls.push(options.headers.Range);
      tracker.active++;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      let pull = 0;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        tracker.active--;
      };
      const body = new ReadableStream({
        pull(controller) {
          if (pull++ === 0) {
            controller.enqueue(data.subarray(start, Math.min(end + 1, start + 6)));
            return;
          }
          release();
          controller.error(new Error('simulated upstream reset'));
        },
        cancel() { release(); },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(end - start + 1),
          ETag: '"reset-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-23' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  assert.deepEqual(calls, ['bytes=0-23', 'bytes=6-23', 'bytes=12-23', 'bytes=18-23']);
  assert.equal(tracker.maxActive, 1);
  assert.equal(tracker.active, 0);
});

test('finite MKV seek waits for mono-account release and bounds transient provider 5xx retries', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  const data = Buffer.from(Array.from({ length: 12 }, (_, index) => 0x30 + index));
  const calls = [];
  const startedAt = [];
  const releaseDelayMs = 40;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: data.length,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    releaseDelayMs,
    finiteNoProgressRetryLimit: 2,
    finiteRetryDelaysMs: [0, 0, 0],
    fetchImpl: async (_url, options) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      calls.push(options.headers.Range);
      startedAt.push(Date.now());
      if (calls.length === 2) {
        return new Response('provider socket still releasing', { status: 503 });
      }
      const body = calls.length === 1
        ? data.subarray(start, Math.min(end + 1, start + 4))
        : data.subarray(start, end + 1);
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(end - start + 1),
          ETag: '"release-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-11' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  assert.deepEqual(calls, ['bytes=0-11', 'bytes=4-11', 'bytes=4-11']);
  assert.ok(startedAt[1] - startedAt[0] >= releaseDelayMs - 5);
  assert.ok(startedAt[2] - startedAt[1] >= releaseDelayMs - 5);
  assert.equal(broker.terminalError, null);
});

test('strict language broker treats provider 5xx as terminal and never retries', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: 12,
    dispatcher: null,
    releaseDelayMs: 0,
    fetchImpl: async () => {
      calls++;
      return new Response('temporarily unavailable', { status: 503 });
    },
  });
  t.after(() => broker.close());

  const response = await fetch(broker.inputUrl, { headers: { Range: 'bytes=0-11' } });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'PROVIDER_REQUEST_FAILED');
  assert.equal(calls, 1);
});

test('strict language broker never reconnects a truncated provider range', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let calls = 0;
  const broker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: 20,
    dispatcher: null,
    releaseDelayMs: 0,
    fetchImpl: async (_url, options) => {
      calls++;
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(Buffer.alloc(4, 0x44), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/20`,
          'Content-Length': String(end - start + 1),
          ETag: '"strict-v1"',
        },
      });
    },
  });
  t.after(() => broker.close());

  await assert.rejects(fetch(broker.inputUrl, { headers: { Range: 'bytes=0-19' } }));
  assert.equal(calls, 1);
  assert.equal(broker.terminalError.code, 'RANGE_LENGTH_MISMATCH');
});

test('finite MKV seek bounds no-progress reconnects and fails closed on validator drift', async (t) => {
  const { createStrictLidBroker } = brokerHarness();
  let emptyCalls = 0;
  const emptyBroker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: 20,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    releaseDelayMs: 0,
    finiteNoProgressRetryLimit: 2,
    finiteRetryDelaysMs: [0, 0, 0],
    fetchImpl: async (_url, options) => {
      emptyCalls++;
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/20`,
          'Content-Length': String(end - start + 1),
          ETag: '"empty-v1"',
        },
      });
    },
  });
  try {
    const response = await fetch(emptyBroker.inputUrl, { headers: { Range: 'bytes=0-19' } })
      .catch(() => null);
    if (response) {
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, 'PROVIDER_RECONNECT_EXHAUSTED');
    }
    assert.equal(emptyCalls, 3);
    assert.equal(emptyBroker.terminalError.code, 'PROVIDER_RECONNECT_EXHAUSTED');
  } finally {
    await emptyBroker.close();
  }

  let validatorCalls = 0;
  const validatorBroker = await createStrictLidBroker({
    sourceUrl: 'https://provider.example/movie/account/secret/title.mkv',
    fileSizeBytes: 20,
    dispatcher: null,
    pathPrefix: 'finite-mkv-seek',
    releaseDelayMs: 0,
    fetchImpl: async (_url, options) => {
      validatorCalls++;
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(Buffer.alloc(Math.min(4, end - start + 1), 0x55), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/20`,
          'Content-Length': String(end - start + 1),
          ETag: validatorCalls === 1 ? '"stable-v1"' : '"changed-v2"',
        },
      });
    },
  });
  try {
    const response = await fetch(validatorBroker.inputUrl, { headers: { Range: 'bytes=0-19' } })
      .catch(() => null);
    if (response) {
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, 'VOD_CHANGED');
    }
    assert.equal(validatorCalls, 2);
    assert.equal(validatorBroker.terminalError.code, 'VOD_CHANGED');
  } finally {
    await validatorBroker.close();
  }
});

test('strict LID rejects invalid exact signed coordinates before creating a server or provider fetch', async () => {
  const { createStrictLidBroker } = brokerHarness();
  let fetches = 0;
  for (const fileSizeBytes of [null, '', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      createStrictLidBroker({
        sourceUrl: 'http://127.0.0.1:9/file.mkv',
        fileSizeBytes,
        dispatcher: null,
        fetchImpl: async () => { fetches++; throw new Error('must not fetch'); },
      }),
      (error) => error && error.code === 'EXACT_FILE_SIZE_REQUIRED',
    );
  }
  assert.equal(fetches, 0);

  const routeStart = gatewaySource.indexOf('async function handleDetectLanguageRequest(');
  const routeEnd = gatewaySource.indexOf("app.post('/extract-language-wav'", routeStart);
  const route = gatewaySource.slice(routeStart, routeEnd);
  assert.ok(route.indexOf("code: 'exact_file_size_required'") < route.indexOf('createStrictLidBroker({'));
  assert.match(route, /normalizeStrictLidTimelineDurationSeconds\(claims\.durationSeconds\)/);
  assert.ok(route.indexOf("code: 'exact_duration_required'") < route.indexOf('createStrictLidBroker({'));
  assert.ok(route.indexOf("code: 'strict_lid_duration_too_short'") < route.indexOf('createStrictLidBroker({'));
  assert.match(
    route,
    /code: 'strict_lid_duration_too_short'[\s\S]*providerDrained: true,[\s\S]*providerDrainProtocol: 1/,
  );
  assert.doesNotMatch(route, /req\.query\.(?:duration|durationSeconds)|WHISPER_STRICT_OFFSETS/);
  assert.match(route, /detectLanguageRequestPolicy\(req, options\)[\s\S]*validateDetectLanguageCapability\(capabilityToken, policy\.requiredScope\)/);
  assert.match(gatewaySource, /strictLidLoopbackBrokerProtocol: 1/);
  assert.match(gatewaySource, /strictLidFileSizeClaim: 'fileSizeBytes'/);
  assert.match(gatewaySource, /const GATEWAY_VERSION = 167/);
  assert.match(gatewaySource, /supersededReleaseDelayMs:\s*PROVIDER_SLOT_RELEASE_DELAY_MS/);
  assert.match(gatewaySource, /strictLidProviderDrainProtocol: 1/);
  assert.match(gatewaySource, /strictLidWeakFallbackProtocol: 1/);
  assert.match(gatewaySource, /strictLidTimelineSamplingProtocol: 1/);
  assert.match(gatewaySource, /strictLidRangeTimeoutProtocol: 2/);
  assert.match(gatewaySource, /strictLidRangeFirstByteTimeoutMs: STRICT_LID_BROKER_FIRST_BYTE_TIMEOUT_MS/);
  assert.match(gatewaySource, /strictLidRangeIdleTimeoutMs: STRICT_LID_BROKER_IDLE_TIMEOUT_MS/);
  assert.match(gatewaySource, /strictLidFfmpegRwTimeoutUs: STRICT_LID_FFMPEG_RW_TIMEOUT_US/);
  assert.match(
    route,
    /const sendDetectionJson = async[\s\S]*await closeStrictBrokerForResponse\(\)[\s\S]*providerDrained: true[\s\S]*providerDrainProtocol: 1/,
  );
  assert.ok(
    route.indexOf('await closeStrictBrokerForResponse()') < route.indexOf('return res.status(status).json(responsePayload)'),
    'the strict broker must drain before any attested JSON response is emitted',
  );
});

test('service-only header LID route authenticates before capability handling and preserves terminal statuses', async () => {
  const start = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(');
  const end = gatewaySource.indexOf('// Service-only production handoff', start);
  assert.ok(start >= 0 && end > start, 'header LID route source must remain extractable');
  const authStart = gatewaySource.indexOf('function requireGatewayAuth(');
  const authEnd = gatewaySource.indexOf('\nfunction requirePlaybackToken(', authStart);
  assert.ok(authStart >= 0 && authEnd > authStart, 'gateway auth guard source must remain extractable');
  const calls = [];
  const postRoutes = new Map();
  const getRoutes = new Map();
  const logs = [];
  const app = {
    post(route, ...handlers) { postRoutes.set(route, handlers); },
    get(route, handler) { getRoutes.set(route, handler); },
  };
  const makeResponse = () => ({
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  });
  vm.runInNewContext(
    `${gatewaySource.slice(authStart, authEnd)}\n${gatewaySource.slice(start, end)}`,
    {
    LID_CAPABILITY_HEADER: 'x-norva-byte-pipe-token',
    LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
    LANGUAGE_METADATA_LANE_ENABLED: false,
    GATEWAY_TOKEN: 'service-secret',
    app,
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(args.join(' ')),
      error: (...args) => logs.push(args.join(' ')),
    },
    handleDetectLanguageRequest: async (_req, res, token, options) => {
      calls.push({ token, options });
      if (token === 'busy.458') return res.status(458).json({ code: 'PROVIDER_BUSY' });
      if (token === 'proxy.407') return res.status(502).json({ code: 'PROXY_AUTH_FAILED', upstreamStatus: 407 });
      return res.status(200).json({ ok: true });
    },
    String,
    timingSafeEqual: (left, right) => left === right,
  });

  const invoke = async (handlers, req, res) => {
    let cursor = -1;
    const dispatch = async (index) => {
      assert.ok(index > cursor, 'middleware next() must advance exactly once');
      cursor = index;
      const handler = handlers[index];
      if (!handler) return;
      let downstream = null;
      const next = () => {
        downstream = dispatch(index + 1);
        return downstream;
      };
      await handler(req, res, next);
      if (downstream) await downstream;
    };
    await dispatch(0);
  };
  const makeRequest = ({ bearer = null, capability = null } = {}) => ({
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    get: (name) => name === 'x-norva-byte-pipe-token' ? capability : undefined,
  });

  const headerRoute = postRoutes.get('/detect-language');
  assert.equal(Array.isArray(headerRoute), true);
  assert.equal(headerRoute.length, 3, 'security headers, service auth, then capability handler');
  assert.equal(getRoutes.has('/detect-language'), false, 'the unauthenticated GET header route is closed');
  assert.equal(typeof getRoutes.get('/detect-language/:token'), 'function', 'legacy path remains explicit compatibility only');

  const missingBearer = makeResponse();
  await invoke(headerRoute, makeRequest({ capability: 'signedPayload.signature' }), missingBearer);
  assert.equal(missingBearer.statusCode, 401);
  assert.equal(calls.length, 0);
  assert.equal(missingBearer.headers['cache-control'], 'no-store');
  assert.equal(missingBearer.headers['x-content-type-options'], 'nosniff');

  const wrongBearer = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'wrong-secret', capability: 'signedPayload.signature' }), wrongBearer);
  assert.equal(wrongBearer.statusCode, 401);
  assert.equal(calls.length, 0);

  const missingCapability = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret' }), missingCapability);
  assert.equal(missingCapability.statusCode, 401);
  assert.equal(calls.length, 0);

  const invalid = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'not a signed token' }), invalid);
  assert.equal(invalid.statusCode, 401);
  assert.equal(calls.length, 0);

  const successToken = 'signedPayload.signature';
  const success = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: successToken }), success);
  assert.equal(success.statusCode, 200);
  assert.equal(calls.at(-1).token, successToken);
  assert.equal(calls.at(-1).options.requiredScope, 'lid-legacy-full');
  assert.equal(success.headers['cache-control'], 'no-store');

  const busy = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'busy.458' }), busy);
  assert.equal(busy.statusCode, 458);
  assert.equal(busy.body.code, 'PROVIDER_BUSY');

  const proxy = makeResponse();
  await invoke(headerRoute, makeRequest({ bearer: 'service-secret', capability: 'proxy.407' }), proxy);
  assert.equal(proxy.statusCode, 502);
  assert.equal(proxy.body.code, 'PROXY_AUTH_FAILED');
  assert.equal(proxy.body.upstreamStatus, 407);

  assert.deepEqual(logs, [], 'the route never logs the header, token, or signed provider URL');
  const handlerStart = gatewaySource.indexOf('function validateDetectLanguageCapability(');
  const handlerEnd = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(', handlerStart);
  const handlerSource = gatewaySource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /verifyRawToken\(capabilityToken, GATEWAY_TOKEN\)/,
    'the header and legacy routes share the exact signature/scope/broker implementation');
  assert.doesNotMatch(handlerSource, /req\.params\.token/);
  assert.doesNotMatch(handlerSource, /console\.(?:log|warn|error)/);
  assert.match(gatewaySource, /strictLidHeaderCapabilityProtocol: 2/);
  assert.match(gatewaySource, /strictLidCapabilityHeader: 'X-Norva-Byte-Pipe-Token'/);
  assert.match(gatewaySource, /strictLidCapabilityMethod: 'POST'/);
  assert.match(gatewaySource, /strictLidServiceAuthRequired: true/);
});

test('strict legacy raw tokens and the service route both require exact lid-legacy-full scope before I/O', () => {
  const start = gatewaySource.indexOf('function validateDetectLanguageCapability(');
  const end = gatewaySource.indexOf('\nasync function handleDetectLanguageRequest(', start);
  assert.ok(start >= 0 && end > start, 'capability policy source must remain extractable');
  const policies = vm.runInNewContext(
    `(() => { ${gatewaySource.slice(start, end)}; return { validateDetectLanguageCapability, detectLanguageRequestPolicy }; })()`,
    {
      Date,
      GATEWAY_TOKEN: 'hmac-secret',
      LID_LEGACY_FULL_SCOPE: 'lid-legacy-full',
      LID_ROUTE_SCOPES: new Set(['lid-production-detect-only', 'lid-shadow', 'lid-legacy-full']),
      String,
      verifyRawToken(token) {
        if (token === 'raw-nonstrict') {
          return { exp: Math.floor(Date.now() / 1000) + 60, scope: 'lid-production-detect-only' };
        }
        if (token === 'full') {
          return { exp: Math.floor(Date.now() / 1000) + 60, scope: 'lid-legacy-full' };
        }
        return null;
      },
    },
  );

  const legacyStrictPolicy = policies.detectLanguageRequestPolicy({ query: { strict: '1' } });
  assert.equal(legacyStrictPolicy.strict, true);
  assert.equal(legacyStrictPolicy.requiredScope, 'lid-legacy-full');
  assert.equal(
    policies.validateDetectLanguageCapability('raw-nonstrict', legacyStrictPolicy.requiredScope).status,
    403,
    'a raw legacy strict token cannot downgrade to detect-only scope',
  );
  assert.equal(
    policies.validateDetectLanguageCapability('full', legacyStrictPolicy.requiredScope).status,
    200,
  );
  const nonStrictPolicy = policies.detectLanguageRequestPolicy({ query: {} });
  assert.equal(nonStrictPolicy.requiredScope, null, 'legacy non-strict compatibility remains explicit');
  assert.equal(policies.validateDetectLanguageCapability('raw-nonstrict', null).status, 200);

  const handlerStart = gatewaySource.indexOf('async function handleDetectLanguageRequest(');
  const handlerEnd = gatewaySource.indexOf('function detectLanguageCapabilityFromHeader(', handlerStart);
  const handler = gatewaySource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('validateDetectLanguageCapability(') < handler.indexOf('WHISPER_BIN'),
    'scope validation happens before configuration, broker, fetch, or spawn');
  assert.ok(handler.indexOf('validateDetectLanguageCapability(') < handler.indexOf('createStrictLidBroker({'));
});

test('strict ffmpeg uses only loopback while provider identity remains in the background ledger', () => {
  const start = gatewaySource.indexOf('function extractAudioWav(');
  const end = gatewaySource.indexOf('// V2 chunked pipeline', start);
  const extraction = gatewaySource.slice(start, end);
  assert.match(extraction, /const strictLoopback = inputOptions\?\.strictLoopback === true/);
  assert.match(extraction, /providerSourceUrl[\s\S]+proxyKeyFromUrl\(providerSourceUrl\)/);
  assert.match(extraction, /registerAccountExtraction\(\s*providerAccountKey/);
  assert.match(extraction, /env: strictLoopback \? loopbackOnlyEnv\(\)/);
  assert.match(extraction, /\.\.\.\(!strictLoopback \? \[[\s\S]+?'-reconnect'/);
  assert.match(extraction, /strictLoopback \? redactStrictLidLoopback\(stderr\) : stderr/);
  assert.match(
    extraction,
    /'-rw_timeout', strictLoopback[\s\S]*STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US[\s\S]*STRICT_LID_FFMPEG_RW_TIMEOUT_US[\s\S]*: '15000000'/,
  );

  const envStart = gatewaySource.indexOf('function loopbackOnlyEnv()');
  const envEnd = gatewaySource.indexOf('// Xtream URLs embed credentials', envStart);
  const envSource = gatewaySource.slice(envStart, envEnd);
  assert.match(envSource, /'http_proxy'[\s\S]+'ALL_PROXY'/);
  assert.match(envSource, /NO_PROXY = '127\.0\.0\.1,localhost,::1'/);
  assert.match(gatewaySource, /function redactStrictLidLoopback\(value\)[\s\S]+?\[strict-lid-loopback\]/);
});

test('v102 keeps the v101 outer extraction invariant: survive 35 s and kill at 45 s', async () => {
  class TimeoutChild extends EventEmitter {
    constructor() {
      super();
      this.stderr = new EventEmitter();
      this.kills = [];
    }

    kill(signal) {
      this.kills.push(signal);
      setImmediate(() => this.emit('close', null, signal));
      return true;
    }
  }

  const child = new TimeoutChild();
  const clock = new FakeClock();
  let spawnedArgs = null;
  const extractAudioWav = audioExtractionHarness((_bin, args) => {
    spawnedArgs = args;
    return child;
  }, {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const resultPromise = extractAudioWav(
    'http://127.0.0.1/strict-lid-input',
    'Norva-LID-Test/1',
    1,
    600,
    20,
    45_000,
    'account-test',
    true,
    null,
    true,
    {
      strictLoopback: true,
      providerSourceUrl: 'https://provider.invalid/account/movie.mkv',
    },
  );
  const rwTimeoutIndex = spawnedArgs.indexOf('-rw_timeout');
  assert.ok(rwTimeoutIndex >= 0);
  assert.equal(spawnedArgs[rwTimeoutIndex + 1], '50000000');
  clock.advance(15_000);
  assert.deepEqual(child.kills, [], 'libav loopback timeout must not win at the legacy 15 s');
  clock.advance(20_000);
  assert.deepEqual(child.kills, [], 'the widened outer timer must survive the former 35 s limit');
  clock.advance(9_999);
  assert.deepEqual(child.kills, []);
  clock.advance(1);
  const result = await resultPromise;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.match(result.error, /extract timeout after 45s/);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.equal(clock.timers.size, 0);
});

test('viewer preemption closes and unregisters a strict LID broker only after provider release', async (t) => {
  const { createStrictLidBroker, strictLidBrokers } = brokerHarness();
  let providerClosed = false;
  const provider = http.createServer((req, res) => {
    const { start, end } = exactRange(req, 100);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/100`,
      'Content-Length': String(end - start + 1),
      ETag: '"close-v1"',
    });
    res.write(Buffer.from([1]));
    res.once('close', () => { providerClosed = true; });
  });
  const sourceUrl = await listen(provider);
  t.after(() => closeServer(provider));
  const broker = await createStrictLidBroker({
    sourceUrl,
    fileSizeBytes: 100,
    dispatcher: null,
    releaseDelayMs: 40,
    openTimeoutMs: 2000,
  });
  const localUrl = broker.inputUrl;
  assert.equal(strictLidBrokers.size, 1);
  const response = await fetch(localUrl, { headers: { Range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  await response.body.getReader().read();
  const closeStartedAt = Date.now();
  await broker.close('viewer-preempted');
  const closeElapsedMs = Date.now() - closeStartedAt;
  const closedDeadline = Date.now() + 500;
  while (!providerClosed && Date.now() < closedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(providerClosed, true);
  assert.ok(
    closeElapsedMs >= 30,
    `broker close acknowledged before provider release grace (${closeElapsedMs}ms)`,
  );
  assert.equal(broker.terminalError.code, 'LANGUAGE_VALIDATION_VIEWER_PREEMPTED');
  assert.equal(strictLidBrokers.size, 0);
  await assert.rejects(fetch(localUrl, { headers: { Range: 'bytes=0-1' } }));
});
