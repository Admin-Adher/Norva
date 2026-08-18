'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('series-info waits for background jobs then retries a busy provider slot', () => {
  const source = read('supabase/functions/norva-series-info/index.ts');
  assert.match(source, /provider_account_busy_for_foreground_validation/);
  assert.match(source, /function waitWhileBackgroundBusy/);
  assert.match(source, /function isProviderSlotBusyError/);
  assert.match(source, /attempt < 3/);
  assert.match(source, /await sleep\(8000\)/);
});

test('series prewarm yields between titles when the viewer is present', () => {
  const source = read('supabase/functions/norva-series-prewarm/index.ts');
  assert.match(source, /provider_account_busy/);
  assert.match(source, /provider-account-busy/);
  assert.match(source, /for \(const seriesId of targets\)/);
});

test('source-sync series inventory already yields between titles', () => {
  const source = read('supabase/functions/norva-source-sync/index.ts');
  assert.match(source, /for \(const parentSeriesId of candidates\) \{[\s\S]*providerBusy\(\)/);
});
