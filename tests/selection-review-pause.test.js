const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

test('withdrawn Selection cannot trap onboarding behind an unusable Enable action; personal source names do not affect filtering', async () => {
  const { discoverySourceId, retiredDiscoverySourceId, DISCOVERY_SELECTION_ENABLED } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const userId = 'review-source-list-owner';
  const archived = { id: await retiredDiscoverySourceId(userId), name: 'Renamed selection', enabled: false };
  const personal = { id: 'personal-source', name: 'Norva Selection', enabled: false };
  const code = fs.readFileSync('supabase/functions/norva-cloud/index.ts','utf8');
  const from = code.indexOf('async function listSources(');
  const to = code.indexOf('async function listVisibleSources(',from);
  const context = vm.createContext({ DISCOVERY_SELECTION_ENABLED, discoverySourceId, retiredDiscoverySourceId,
    SOURCE_MANAGEMENT_PUBLIC_SELECT: 'id', sanitizeSource: row => row,
    throwDb: () => { throw Error('Unexpected database error'); } });
  vm.runInContext(stripTypeScriptTypes(code.slice(from,to),{mode:'strip'}),context);
  let rows = [archived,personal];
  const db = { from: () => ({ select() { return this; }, eq() { return this; }, is() { return this; },
    order: async () => ({ data:rows, error:null }) }) };
  const result = await context.listSources(userId,db);
  assert.equal(result.sources.length,1);
  assert.equal(result.sources[0],personal);
  rows = [archived];
  assert.equal((await context.listSources(userId,db)).sources.length,0);
});
