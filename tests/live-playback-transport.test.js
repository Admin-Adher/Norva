const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/components/VideoPlayer.js'),
  'utf8',
);

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('a healthy relay live stream is not promoted to Gateway by a network drop', () => {
  const fallback = section('tryLiveCodecFallback(data = {})', 'async updateTranscodeStatus');
  const healthyGuard = fallback.indexOf(
    'if (onRelay && this.hasCurrentMedia() && !isDecodeErr) return false;',
  );
  const promotion = fallback.indexOf('list.forceTranscodeChannel(ch)');

  assert.ok(healthyGuard >= 0, 'healthy relay transport guard is missing');
  assert.ok(promotion > healthyGuard, 'healthy transport must be rejected before Gateway promotion');
  assert.match(fallback, /if \(onRelay && !data\.fatal && !isDecodeErr\) return false;/);
});

test('real relay media/decode failures still retain the Gateway transcode fallback', () => {
  const fallback = section('tryLiveCodecFallback(data = {})', 'async updateTranscodeStatus');

  assert.match(fallback, /data\.type === Hls\.ErrorTypes\.MEDIA_ERROR/);
  assert.match(fallback, /codec\|bufferappend\|bufferadd\|incompatible\|parsing\|decode\|demux/i);
  assert.match(fallback, /list\.forceTranscodeChannel\(ch\)/);
});
