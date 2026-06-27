const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyUpstreamError, sanitizeErrorMessage } = require('../server/utils/upstreamError');

test('classifies user_multi_ip as a provider connection-slot refusal', () => {
  const result = classifyUpstreamError('IPTV provider request failed — user_multi_ip');

  assert.equal(result.code, 'UPSTREAM_MULTI_IP');
  assert.equal(result.upstreamStatus, 429);
  assert.equal(result.terminal, true);
  assert.match(result.friendly, /one active connection/i);
  assert.match(result.details, /user_multi_ip/);
});

test('classifies max connections wording as the same single-slot provider issue', () => {
  const result = classifyUpstreamError('Your line has reached max connections allowed');

  assert.equal(result.code, 'UPSTREAM_MULTI_IP');
  assert.equal(result.upstreamStatus, 429);
});

test('redacts credentials embedded in provider errors', () => {
  const sanitized = sanitizeErrorMessage('failed http://host/live/demo/secret/123.ts?username=demo&password=secret');

  assert.equal(sanitized.includes('secret'), false);
  assert.match(sanitized, /\[stream URL\]/);
});
