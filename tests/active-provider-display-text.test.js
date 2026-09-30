const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-provider-access/index.ts'), 'utf8');
const functions = source.slice(source.indexOf('function activeCategories('), source.indexOf('function activeTitlePayload('));
class WorkerFault extends Error {}
const {activeCategories, activeMediaRows} = Function('WorkerFault', 'nullableString', 'compactActiveRecord', 'xtreamLanguageDeclarations', 'isRecord',
  functions + '\nreturn {activeCategories,activeMediaRows};')(
  WorkerFault, v => v == null ? null : String(v).trim(), v => v, () => null,
  v => !!v && typeof v === 'object' && !Array.isArray(v));

for (const kind of ['movie','series','live']) {
  test(`${kind} preserves provider identity while normalizing printable display whitespace`, () => {
    const input = {series_id:'13621',stream_id:'13621',name:'  Se\u0301rie\tPartie\r\nDeux  '};
    const before = JSON.stringify(input);
    const [row] = activeMediaRows({}, [input], kind);
    assert.equal(row.title, 'Série Partie  Deux');
    assert.equal(row.external_id, '13621');
    assert.equal(row.playback_hint.streamId, '13621');
    assert.equal(JSON.stringify(input), before);
  });
}
test('category display whitespace is normalized without changing its key or ordinal', () => {
  assert.deepEqual(activeCategories([{category_id:'42',category_name:'FR\tSéries\nHD'}],7),
    [{category_ordinal:7,provider_category_id:'42',category_name:'FR Séries HD'}]);
});
test('non-printing data, blank labels, oversized labels and malformed IDs remain rejected', () => {
  for (const name of ['\t\r\n','Bad\u0000Name','Bad\u000bName','Bad\u007fName','a'.repeat(2001)]) {
    assert.throws(() => activeMediaRows({}, [{series_id:'42',name}], 'series'), WorkerFault);
    assert.throws(() => activeCategories([{category_id:'42',name}],0), WorkerFault);
  }
  for (const id of ['', 'bad\tid', 'bad\nid', 'a'.repeat(1201)]) {
    assert.throws(() => activeMediaRows({}, [{series_id:id,name:'Valid'}], 'series'), WorkerFault);
    assert.throws(() => activeCategories([{category_id:id,name:'Valid'}],0), WorkerFault);
  }
});
