'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const vm = require('node:vm');

const gateway = fs.readFileSync(
  path.join(__dirname, '..', 'services/media-gateway/src/index.js'),
  'utf8',
);

function loadRawGuardHelpers() {
  const start = gateway.indexOf('const NON_MEDIA_CONTENT_TYPE_RE');
  const end = gateway.indexOf('// Rebuild a Node stream', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = `
    const RAW_PREFIX_SNIFF_BYTES = 512;
    const RAW_FIRST_BYTE_TIMEOUT_MS = 5000;
    ${gateway.slice(start, end)}
    this.rawGuard = {
      classifyRawPrefix,
      rawResponseStartsAtZero,
      isDeclaredEmptyRawResponse,
      sniffLeadingBytes,
      cancelRawBodyBestEffort,
      waitForRawBackoff,
      createRawAttemptGuard,
    };
  `;
  const context = {
    AbortController,
    Buffer,
    Promise,
    ReadableStream,
    TextDecoder,
    clearTimeout,
    console: { warn() {} },
    redactCreds: String,
    setTimeout,
  };
  vm.runInNewContext(source, context);
  return context.rawGuard;
}

const helpers = loadRawGuardHelpers();

test('raw startup has one authoritative deadline capped below the native watchdog', () => {
  assert.match(
    gateway,
    /RAW_STARTUP_DEADLINE_MS = clampInt\(process\.env\.RAW_STARTUP_DEADLINE_MS, 27_000, 5_000, 28_000\)/,
  );
  const routeStart = gateway.indexOf("app.get('/raw/:token'");
  const routeEnd = gateway.indexOf('// Tee the leading bytes', routeStart);
  const route = gateway.slice(routeStart, routeEnd);
  assert.match(route, /startupDeadlineAt = Date\.now\(\) \+ RAW_STARTUP_DEADLINE_MS/);
  assert.match(route, /signal: attemptGuard\.signal/);
  assert.match(route, /waitForRawBackoff\(delayMs, startupDeadlineAt, ac\.signal\)/);
  assert.match(route, /probe\.prefixTimedOut\) noDataKind = 'prefix_timeout'/);
  assert.match(route, /res\.flushHeaders\(\);\s*nodeStream\.pipe\(res\)/);
  assert.doesNotMatch(route, /await upstream\.body\?\.cancel\(\)/);
  assert.doesNotMatch(route, /await probe\.reader\.cancel\(\)/);
});

test('raw prefix classifier accepts split-capable manifests and known binary formats', () => {
  assert.equal(helpers.classifyRawPrefix(Buffer.from('#E'), 'application/octet-stream', true), 'need-more');
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('\uFEFF  \r\n#EXTM3U\n#EXT-X-VERSION:3'), 'text/plain', true),
    'media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('<?xml version="1.0"?><MPD type="static">'), 'application/xml', true),
    'media',
  );
  assert.equal(helpers.classifyRawPrefix(Buffer.from('fLaC\x00\x00'), 'application/octet-stream', true), 'media');
  assert.equal(helpers.classifyRawPrefix(Buffer.from([0xde, 0xad, 0xbe, 0xef]), '', true), 'media');
});

test('raw prefix classifier rejects explicit provider errors but fails open unknown octet-stream text', () => {
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('<html><body>Maximum connections reached</body></html>'), 'application/octet-stream', true, true),
    'non-media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('{"error":"user_multi_ip"}'), '', true, true),
    'non-media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('{"error":"الحساب محظور"}'), 'application/octet-stream', true, true),
    'non-media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('an unknown provider preamble'), 'application/octet-stream', true, true),
    'media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('an unknown textual error'), 'text/plain', true, true),
    'non-media',
  );
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('Compte expir\u00e9'), 'text/plain; charset=utf-8', true, true),
    'non-media',
  );
  assert.equal(helpers.classifyRawPrefix(Buffer.from('G'), 'text/plain', true), 'need-more');
  assert.equal(
    helpers.classifyRawPrefix(Buffer.from('Gateway Timeout'), 'text/plain', true, true),
    'non-media',
  );
});

test('raw prefix classifier requires two MPEG-TS packet sync bytes', () => {
  const transportStream = Buffer.alloc(376, 0x20);
  transportStream[0] = 0x47;
  transportStream[188] = 0x47;
  assert.equal(helpers.classifyRawPrefix(transportStream, 'text/plain', true), 'media');
});

test('raw response offset is derived from provider response, not the requested Range', () => {
  const response = (status, contentRange = '') => ({
    status,
    headers: { get(name) { return name === 'content-range' ? contentRange : null; } },
  });
  assert.equal(helpers.rawResponseStartsAtZero(response(200)), true);
  assert.equal(helpers.rawResponseStartsAtZero(response(206, 'bytes 0-1023/9000')), true);
  assert.equal(helpers.rawResponseStartsAtZero(response(206, 'bytes 1024-2047/9000')), false);
});

test('raw guard treats body-less, 204/205 and declared zero-length successes as empty', () => {
  const response = (status, body, contentLength = '') => ({
    status,
    body,
    headers: { get(name) { return name === 'content-length' ? contentLength : null; } },
  });
  assert.equal(helpers.isDeclaredEmptyRawResponse(response(200, null)), true);
  assert.equal(helpers.isDeclaredEmptyRawResponse(response(204, {})), true);
  assert.equal(helpers.isDeclaredEmptyRawResponse(response(205, {})), true);
  assert.equal(helpers.isDeclaredEmptyRawResponse(response(206, {}, '0')), true);
  assert.equal(helpers.isDeclaredEmptyRawResponse(response(206, {}, '1024')), false);
});

test('prefix sniff combines split HLS chunks and replays every consumed byte', async () => {
  const parts = ['\uFEFF  #E', 'XTM3U\n#EXTINF:10,\n'];
  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(Buffer.from(part));
      controller.close();
    },
  });
  const probe = await helpers.sniffLeadingBytes(
    body,
    new AbortController().signal,
    100,
    (prefix, complete) => helpers.classifyRawPrefix(prefix, 'text/plain', true, complete),
  );
  assert.equal(probe.classification, 'media');
  assert.equal(probe.chunk.toString('utf8'), parts.join(''));
  helpers.cancelRawBodyBestEffort(probe.reader);
});

test('an ambiguous partial prefix that stalls is marked for retry, never piped with a lost read', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('#E'));
    },
  });
  const probe = await helpers.sniffLeadingBytes(
    body,
    new AbortController().signal,
    20,
    (prefix, complete) => helpers.classifyRawPrefix(prefix, 'application/octet-stream', true, complete),
  );
  assert.equal(probe.timedOut, false);
  assert.equal(probe.prefixTimedOut, true);
  assert.equal(probe.classification, 'need-more');
  helpers.cancelRawBodyBestEffort(probe.reader);
});

test('backoff stops at the route deadline and cancellation never awaits a provider', async () => {
  const started = Date.now();
  const outcome = await helpers.waitForRawBackoff(
    1000,
    Date.now() + 25,
    new AbortController().signal,
  );
  assert.equal(outcome, 'deadline');
  assert.ok(Date.now() - started < 250);

  const cancelStarted = Date.now();
  helpers.cancelRawBodyBestEffort({ cancel: () => new Promise(() => {}) });
  assert.ok(Date.now() - cancelStarted < 50);
});
