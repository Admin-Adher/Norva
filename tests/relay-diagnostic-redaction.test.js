'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('relay diagnostic never publishes raw request or exception data', async () => {
  const { sanitizeEvent } = await import('../ops/cloudflare/tail-relay-diagnostic.mjs');
  const result = sanitizeEvent({ outcome: 'exception', eventTimestamp: 1789350000000,
    event: { request: { url: 'https://SECRET/path?token=SECRET', headers: { Authorization: 'SECRET' } } },
    exceptions: [{ name: 'SECRET', message: 'FixedLengthStream too few bytes SECRET', stack: 'SECRET' }],
    logs: [{ message: [JSON.stringify({ tag: 'norva-relay-range-resumed', attempt: 1, reason: 'interrupted', url: 'SECRET' }),
      'SECRET', { tag: 'SECRET', status: 500 }] }] });
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(result.exceptions, ['stream-length']);
  assert.deepEqual(result.signals, [{ tag: 'norva-relay-range-resumed', attempt: 1, reason: 'interrupted' }]);
});

test('relay diagnostic parses chunked pretty JSON and ignores preamble', async () => {
  const { jsonObjectReader, sanitizeEvent } = await import('../ops/cloudflare/tail-relay-diagnostic.mjs');
  const result = [], read = jsonObjectReader(event => result.push(sanitizeEvent(event)));
  const raw = 'Connected to relay\n' + JSON.stringify({ outcome: 'ok', secret: 'quoted { } \\" SECRET' }, null, 2)
    + '\n' + JSON.stringify({ outcome: 'exceededCpu', exceptions: [{ message: 'CPU limit' }] });
  for (let i=0; i<raw.length; i+=3) read(raw.slice(i,i+3));
  assert.equal(result.length, 2);
  assert.equal(result[1].outcome, 'exceededCpu');
  assert.deepEqual(result[1].exceptions, ['cpu-limit']);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
