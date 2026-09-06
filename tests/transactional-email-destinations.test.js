const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const shared = path.resolve(__dirname, '../supabase/functions/_shared');
const sources = 'https://norva.tv/app.html#settings/sources';
const catalog = 'https://norva.tv/app.html#home';

function primaryLink(rendered) {
  // The CTA is the only styled inline-block link in the existing email shell.
  const match = rendered.html.match(/<a href="([^"]+)" style="display:inline-block;[^>]+>([^<]+)<\/a>/);
  assert.ok(match, 'exactly one usable primary action is rendered');
  assert.equal((rendered.html.match(/style="display:inline-block;/g) || []).length, 1);
  return { url: match[1], label: match[2] };
}

test('welcome explains both access types and points to the source screen without inventing a delivery', async () => {
  const { renderWelcome } = await importTypescriptModule(path.join(shared, 'lifecycle-email.ts'));
  const rendered = renderWelcome(null);
  assert.deepEqual(primaryLink(rendered), { url: sources, label: 'Connect my source' });
  assert.ok(rendered.text.includes(`Connect my source: ${sources}`));
  for (const text of [rendered.text, rendered.html]) {
    assert.match(text, /M3U/);
    assert.match(text, /full playlist URL, not the provider's homepage/);
    assert.match(text, /Xtream/);
    assert.match(text, /server URL, username and password/);
    assert.match(text, /Only have an app login/);
    assert.match(text, /Never email us your password or private playlist URL/);
    assert.doesNotMatch(text, /lifecycleDelivery|token_hash|One step to start watching/);
  }
  assert.deepEqual(rendered.tags, [
    { name: 'app', value: 'norva' },
    { name: 'category', value: 'transactional' },
    { name: 'flow', value: 'welcome' },
  ]);
});

test('each import state opens the right existing screen in HTML and frozen plain text', async () => {
  const templates = await importTypescriptModule(path.join(shared, 'import-email.ts'));
  const providers = [{ name: 'Demo catalog', movies: 12, failureDisposition: 'action_required' }];
  const cases = [
    ['renderImportStarted', sources, 'Check import status'],
    ['renderImportCompleted', catalog, 'View my catalog'],
    ['renderImportFailed', sources, 'Review my source'],
  ];
  for (const [method, url, label] of cases) {
    const rendered = templates[method](null, providers);
    assert.deepEqual(primaryLink(rendered), { url, label });
    assert.ok(rendered.text.includes(`${label}: ${url}`));
    const frozenText = templates.plainTextFromImportHtml(rendered.html);
    assert.ok(frozenText.includes(`${label} (${url})`));
    const parsed = new URL(url);
    assert.equal(parsed.search, '');
    assert.equal(parsed.username, '');
    assert.equal(parsed.password, '');
    assert.doesNotMatch(`${url}\n${frozenText}`, /lifecycleDelivery|sourceId|token_hash/);
  }
});

test('recipient or provider names cannot change the destination or insert a second CTA', async () => {
  const templates = await importTypescriptModule(path.join(shared, 'import-email.ts'));
  const { renderWelcome } = await importTypescriptModule(path.join(shared, 'lifecycle-email.ts'));
  const name = '\"><a href="https://untrusted.example/">click</a><script>alert(1)</script>';
  for (const rendered of [renderWelcome(name), templates.renderImportFailed(name, [{ name }])]) {
    assert.equal(primaryLink(rendered).url, sources);
    assert.doesNotMatch(rendered.html, /<script>|<a href="https:\/\/untrusted/);
    assert.match(rendered.html, /&lt;a href=&quot;https:/);
  }
});
