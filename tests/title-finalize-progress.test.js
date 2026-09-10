'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-source-sync/index.ts'), 'utf8');
const start = source.indexOf('function titleFinalizePercent(');
const end = source.indexOf('\nasync function countRowsByType(', start);
const context = { module: { exports: {} } };
vm.runInNewContext(transformSync(`${source.slice(start, end)}\nmodule.exports = titleFinalizePercent`, { loader: 'ts' }).code, context);
const progress = context.module.exports;

test('title progress uses all VOD rows, not the threshold that unlocks browsing', () => {
  assert.match(source, /percent: done \? 90 : titleFinalizePercent\(nextOffset, totalVod\)/);
  assert.doesNotMatch(source, /titleFinalizePercent\(nextOffset, thresholds\.usable\)/);
  assert.equal(progress(2000, 40000), 75);
  assert.equal(progress(20000, 40000), 82);
  assert.equal(progress(40000, 40000), 90);
});
test('resumed cinema-first imports rebase an old premature 90% without changing legacy phase ordering', () => {
  assert.match(source, /percent: phase === "titles" && !legacyLiveFirst\s*\? titleFinalizePercent\(batchOffset, counts\.movies \+ counts\.series\)\s*: Math\.max\(74, Number\(existingProgress\.percent/);
  assert.equal(progress(2000, 40000), 75);
  assert.equal(progress(0, 40000), 74);
});
test('empty, small and oversized finalization counts remain bounded and monotone', () => {
  assert.equal(progress(0, 0), 90);
  assert.equal(progress(-100, 100), 74);
  assert.equal(progress(1000, 100), 90);
  let previous = 74;
  for (let count = 0; count <= 10000; count += 100) {
    const percent = progress(count, 10000);
    assert.ok(percent >= previous && percent <= 90);
    previous = percent;
  }
});
