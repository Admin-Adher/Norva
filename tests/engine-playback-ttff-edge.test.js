const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const playback = fs.readFileSync(
  path.join(root, 'supabase/functions/norva-playback/index.ts'),
  'utf8',
);

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

test('engine playback never waits for provider track enrichment before returning its URL', () => {
  const engineRoute = between(
    playback,
    '// Still missing',
    '// The grouped-title language facets',
  );

  assert.match(engineRoute, /const shouldBlockPlaybackForTrackEnrichment = false/);
  assert.match(
    engineRoute,
    /if\s*\(shouldBlockPlaybackForTrackEnrichment\s*&&\s*\(!haveAudio\s*\|\|\s*!haveSub\)\)/,
    'the old probe path must remain fail-closed outside the viewer startup budget',
  );
  assert.match(
    engineRoute,
    /belongs to the enrichment fleet/i,
    'the non-blocking ownership decision must remain explicit',
  );
});

test('playback health publishes the non-blocking engine-track contract', () => {
  assert.match(playback, /version:\s*65/);
  assert.match(playback, /engineTrackProbeBlocking:\s*false/);
});
