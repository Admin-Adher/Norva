const test = require('node:test');
const assert = require('node:assert/strict');

test('targeted quarantine contains four immutable media identities, never an entire feed', async () => {
  const { SELECTION_LIVE_QUARANTINE: entries, matchesSelectionLiveQuarantine: matches } = await import('../supabase/functions/_shared/selection-live-quarantine.mjs');
  assert.equal(entries.length, 4);
  assert.ok(Object.isFrozen(entries));
  assert.equal(new Set(entries.map(entry => entry.externalId)).size, 4);
  for (const entry of entries) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(matches(entry), true);
    for (const key of ['feedId', 'externalId', 'mediaKeySha256', 'targetUrlSha256']) {
      assert.equal(matches({ ...entry, [key]: 'different' }), false, key);
      assert.equal(matches({ ...entry, [key]: undefined }), false, key);
    }
  }
  assert.equal(matches(null), false);
  assert.equal(matches({ feedId: 'iptv-org' }), false);
  assert.equal(matches({ feedId: 'plex' }), false);
});
