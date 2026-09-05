const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');
const relay = fs.readFileSync(path.join(__dirname, '../services/norva-relay/src/index.js'), 'utf8');

test('HLS audio, subtitle, iframe, key and segment URLs retain the signed session identity', async () => {
  const from = relay.indexOf('async function rewriteHlsPlaylist(');
  const to = relay.indexOf('async function verifyRelayToken(', from);
  const rewrite = vm.runInNewContext(`${relay.slice(from, to)}\nrewriteHlsPlaylist`, {
    URL, encoder: new TextEncoder(),
    base64Url: bytes => Buffer.from(bytes).toString('base64url'),
    hmacBase64Url: async (secret, value) => createHmac('sha256', secret).update(value).digest('base64url'),
    publicBaseUrl: () => 'https://relay.example.test',
  });
  const claims = { v: 2, purpose: 'playback', sid: 'owned-session', route: 'sealed-route', exp: 2000000000 };
  const secret = 'test-only-secret';
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",URI="audio/playlist.m3u8?lang=fr"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="https://subs.example.test/en.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=10000,URI="iframes.m3u8"',
    '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="session.key"',
    '#EXT-X-KEY:METHOD=AES-128,URI="segment.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO="audio",SUBTITLES="subs"',
    'video/playlist.m3u8',
  ].join('\n');
  const output = await rewrite(playlist, 'https://video.example.test/vod/master.m3u8', claims, { RELAY_TOKEN_SECRET: secret }, {});
  const urls = [...output.matchAll(/URI="([^"]+)"/g)].map(match => match[1]);
  urls.push(output.split('\n').at(-1));
  assert.equal(urls.length, 7);
  const targets = [];
  for (const url of urls) {
    assert.ok(url.startsWith('https://relay.example.test/relay/'), 'every media reference must be absolute and signed');
    const [encoded, signature] = new URL(url).pathname.slice('/relay/'.length).split('.');
    const payload = Buffer.from(encoded, 'base64url').toString();
    assert.equal(signature, createHmac('sha256', secret).update(payload).digest('base64url'));
    const decoded = JSON.parse(payload);
    for (const key of ['v', 'purpose', 'sid', 'route', 'exp']) assert.equal(decoded[key], claims[key]);
    targets.push(decoded.url);
  }
  assert.equal(targets[0], 'https://video.example.test/vod/audio/playlist.m3u8?lang=fr');
  assert.equal(targets[1], 'https://subs.example.test/en.m3u8');
  assert.equal(targets[6], 'https://video.example.test/vod/video/playlist.m3u8');
  assert.match(output, /BANDWIDTH=3000000,AUDIO="audio",SUBTITLES="subs"/);
});
