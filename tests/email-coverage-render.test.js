const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
test('behavioral marketing keeps its real destination and carries visible unsubscribe controls', async () => {
  const { renderBehavioralLifecycle } = await importTypescriptModule(path.join(__dirname, '../supabase/functions/_shared/lifecycle-email.ts'));
  const opts = { subject: 'Continue watching', body: 'Your progress is saved.', ctaLabel: 'Continue watching',
    ctaUrl: 'https://norva.tv/app.html?lifecycleDelivery=10000000-0000-4000-8000-000000000001#home/resume', flow: 'behavioral_continue_watching' };
  const marketing = renderBehavioralLifecycle(null, {...opts, unsubscribeUrl:'https://api.norva.tv/functions/v1/norva-lifecycle/unsubscribe?token=fixture'});
  assert.equal(marketing.tags[1].value,'marketing');
  assert.match(marketing.html,/Unsubscribe/);
  assert.match(marketing.text,/unsubscribe\?token=fixture/);
  assert.match(marketing.html,/#home\/resume/);
  const service = renderBehavioralLifecycle(null,opts);
  assert.equal(service.tags[1].value,'transactional');
  assert.doesNotMatch(service.html,/unsubscribe\?token/);
});
