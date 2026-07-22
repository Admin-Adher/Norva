'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const gateway = fs.readFileSync(
  path.join(root, 'services/media-gateway/src/index.js'),
  'utf8',
);
const routeStart = gateway.indexOf("app.post('/extract-language-wav'");
const routeEnd = gateway.indexOf('// Service-only A/B benchmark.', routeStart);
const route = gateway.slice(routeStart, routeEnd);

test('language WAV extraction is a v79 service-only scoped contract', () => {
  assert.match(gateway, /const GATEWAY_VERSION = 79/);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  assert.match(
    gateway,
    /const LID_CASCADE_WAV_SCOPES = new Set\(\[[\s\S]*'lid-cascade-shadow-v1'[\s\S]*'lid-cascade-untagged-canary-v1'[\s\S]*'lid-cascade-untagged-primary-v1'/,
  );
  assert.match(
    route,
    /app\.post\('\/extract-language-wav', requireGatewayAuth/,
  );
  assert.match(route, /req\.get\('x-norva-lid-assertion'\)/);
  assert.match(route, /verifyRawToken\(assertion, GATEWAY_TOKEN\)/);
  assert.doesNotMatch(route, /req\.params\.token/);
  assert.match(route, /LID_CASCADE_WAV_SCOPES\.has\(String\(claims\.scope/);
  assert.match(route, /Number\.isSafeInteger\(expiresAtSeconds\)/);
  assert.match(route, /expiresAtSeconds > nowSeconds \+ 15 \* 60/);
  assert.match(route, /res\.setHeader\('Cache-Control', 'no-store'\)/);
  assert.doesNotMatch(route, /WHISPER_BIN|runWhisper|Ecapa|Sherpa/);
});

test('JSON input is numeric, bounded and supports the rollout duration alias safely', () => {
  assert.match(route, /const trackIndex = body\.index/);
  assert.match(route, /const startOffset = body\.start/);
  assert.match(route, /hasDurationSeconds \? body\.durationSeconds : body\.dur/);
  assert.match(route, /body\.durationSeconds !== body\.dur/);
  assert.match(
    route,
    /Number\.isInteger\(trackIndex\) \|\| trackIndex < 0 \|\| trackIndex > 1024/,
  );
  assert.match(
    route,
    /typeof startOffset !== 'number'[\s\S]*startOffset < 0 \|\| startOffset > 21600/,
  );
  assert.match(
    route,
    /typeof duration !== 'number'[\s\S]*duration < 8 \|\| duration > 30/,
  );
  assert.doesNotMatch(route, /Number\.parse(?:Int|Float)\(body\.(?:index|start|dur)/);
});

test('extraction fails fast for global CPU work and the exact provider account only', () => {
  for (const guard of [
    'lidLanguageWavActive > 0',
    'lidBenchmarkBusy',
    'lidProductionCpuBusy()',
    'isAccountJobBusy(lockKey)',
    'accountSlotBusyLocally(claims.url)',
  ]) {
    assert.ok(route.includes(guard), `missing busy guard: ${guard}`);
  }
  assert.doesNotMatch(route, /activeSessionCount\(\) > 0|rawPumps\.size > 0/);
  assert.match(route, /res\.setHeader\('Retry-After', '30'\)/);
  assert.match(
    route,
    /withAccountJobLock\(lockKey, \(\) =>\s*extractAudioWav\(/,
  );
  assert.match(route, /clientAbort\.signal/);
  assert.match(route, /if \(ex\.aborted\)/);
  assert.match(route, /sanitizeUserAgent\(claims\.ua\) \|\| FFMPEG_USER_AGENT/);
  assert.match(route, /sanitizeLanguageWavError\(ex\.error, claims\.url\)/);
});

test('response is a bounded integrity-described WAV and sensitive bytes are always destroyed', () => {
  assert.match(gateway, /const LID_LANGUAGE_WAV_MAX_BYTES = 1536 \* 1024/);
  assert.match(route, /inspectLanguageWavBuffer\(wavBuffer\)/);
  assert.match(route, /crypto\.createHash\('sha256'\)\.update\(wavBuffer\)\.digest\('hex'\)/);
  for (const header of [
    'Content-Type',
    'Content-Length',
    'X-Norva-Sample-Sha256',
    'X-Norva-Audio-Sha256',
    'X-Content-Sha256',
    'X-Norva-Sample-Bytes',
    'X-Norva-Audio-Seconds',
    'X-Norva-Extract-Ms',
  ]) {
    assert.ok(route.includes(`res.setHeader('${header}'`), `missing header: ${header}`);
  }
  assert.match(route, /await endLanguageWavResponse\(res, wavBuffer\)/);
  assert.match(
    route,
    /finally \{[\s\S]*wavBuffer\.fill\(0\)[\s\S]*await fsp\.unlink\(wavPath\)\.catch\(\(\) => \{\}\)[\s\S]*lidLanguageWavActive = Math\.max/,
  );
  assert.match(
    gateway,
    /function sanitizeLanguageWavError[\s\S]*sanitizeLog\([\s\S]*redactCreds\(/,
  );
});

test('RIFF validator accepts only mono 16 kHz PCM16 and rejects format drift', () => {
  const helperStart = gateway.indexOf('function inspectLanguageWavBuffer');
  const helperEnd = gateway.indexOf('// Keep the response buffer alive', helperStart);
  assert.notEqual(helperStart, -1);
  assert.notEqual(helperEnd, -1);
  const helperSource = gateway.slice(helperStart, helperEnd).trim();
  const inspect = vm.runInNewContext(`(${helperSource})`, {
    Buffer,
    LID_LANGUAGE_WAV_MAX_BYTES: 1536 * 1024,
  });

  function wav({ channels = 1, sampleRate = 16000, bitsPerSample = 16, seconds = 1 } = {}) {
    const blockAlign = channels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataBytes = Math.round(seconds * byteRate);
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataBytes, 40);
    return buffer;
  }

  const valid = inspect(wav());
  assert.equal(valid.channels, 1);
  assert.equal(valid.sampleRate, 16000);
  assert.equal(valid.bitsPerSample, 16);
  assert.equal(valid.audioSeconds, 1);
  assert.throws(() => inspect(wav({ channels: 2 })), /mono 16 kHz PCM/);
  assert.throws(() => inspect(wav({ sampleRate: 48000 })), /mono 16 kHz PCM/);
  assert.throws(() => inspect(Buffer.from('not a wav')), /byte length|RIFF/);
});

test('health exposes capability, limits, live activity and bounded counters', () => {
  const healthStart = gateway.indexOf("app.get('/health'");
  const healthEnd = gateway.indexOf("app.get('/debug/failures'", healthStart);
  const health = gateway.slice(healthStart, healthEnd);
  assert.match(health, /languageWavExtraction: \{/);
  assert.match(health, /available: true/);
  assert.match(health, /scopes: \[\.\.\.LID_CASCADE_WAV_SCOPES\]/);
  assert.match(health, /maxBytes: LID_LANGUAGE_WAV_MAX_BYTES/);
  assert.match(health, /active: lidLanguageWavActive/);
  assert.match(health, /languageWavExtractionStats: \{/);
  assert.match(health, /\.\.\.lidLanguageWavStats/);
  assert.match(health, /averageExtractMs:/);
  for (const counter of [
    'requests',
    'attempts',
    'successes',
    'invalidTokens',
    'invalidRequests',
    'busyRejections',
    'extractionFailures',
    'validationFailures',
    'oversized',
    'responseAborts',
    'bytesServed',
    'totalExtractMs',
    'last',
  ]) {
    assert.match(
      gateway,
      new RegExp(`\\b${counter}:`),
      `missing language WAV counter: ${counter}`,
    );
  }
});
