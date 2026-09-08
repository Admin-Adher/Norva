const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

test('renewal notice gives the actual UTC date, a management link and no invented price', async () => {
  const { renderRenewalUpcoming } = await importTypescriptModule(path.join(__dirname, '../supabase/functions/_shared/lifecycle-email.ts'));
  const email = renderRenewalUpcoming('<script>bad</script>', { renewsAt: '2026-09-15T23:30:00Z' });
  assert.match(email.text, /15 September 2026 \(UTC\)/);
  assert.match(email.html, /15 September 2026 \(UTC\)/);
  assert.match(email.text, /https:\/\/norva.tv\/subscription.html/);
  assert.doesNotMatch(email.html, /<script>/);
  assert.doesNotMatch(email.text, /\$\d|USD|payment was processed|charged successfully/i);
  assert.deepEqual(email.tags, [{ name: 'app', value: 'norva' }, { name: 'category', value: 'transactional' }, { name: 'flow', value: 'renewal_upcoming' }]);
  assert.throws(() => renderRenewalUpcoming(null, { renewsAt: 'invalid' }), /valid renewal date/);
});
