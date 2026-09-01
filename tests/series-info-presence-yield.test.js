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

test('series-info returns cold episode payloads before best-effort inventory RPCs finish', () => {
  const source = read('supabase/functions/norva-series-info/index.ts');
  const routeStart = source.indexOf('segments[2] === "series-info"');
  const routeEnd = source.indexOf('throw new HttpError(404', routeStart);
  const route = source.slice(routeStart, routeEnd);
  const finalGuard = route.lastIndexOf('await assertSourceSnapshotCurrent(');
  const schedule = route.indexOf('scheduleSeriesEpisodeRegistration(', finalGuard);
  const response = route.indexOf('return json(req', schedule);

  assert.ok(finalGuard >= 0 && schedule > finalGuard && response > schedule);
  assert.doesNotMatch(route, /await scheduleSeriesEpisodeRegistration/);
  assert.match(source, /Promise\.resolve\(\)\s*\.then\(\(\) => registerSeriesEpisodes/);
  assert.match(source, /EdgeRuntime\?: \{ waitUntil\?:/);
  assert.match(source, /runtime\?\.waitUntil/);
  assert.match(source, /runtime\.waitUntil\(task\)/);
  assert.match(source, /if \(isCatalogAccessGuardError\(error\) \|\| isCatalogGenerationSuperseded\(error\)\) return;/);
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
