const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

const edgeRenderers = [
  'supabase/functions/_shared/import-email.ts',
  'supabase/functions/_shared/lifecycle-email.ts',
  'supabase/functions/_shared/subtitle-ready-email.ts',
  'supabase/functions/norva-auth-email/index.ts',
  'supabase/functions/norva-account-delete/index.ts',
  'supabase/functions/norva-support/index.ts',
  'supabase/functions/norva-auth-challenge/index.ts',
  'supabase/functions/norva-provider-access-notify/index.ts',
];

test('every active Edge email renderer uses the shared client-safe envelope with truthful locale', async () => {
  for (const file of edgeRenderers) {
    const source = read(file);
    assert.match(source, /import\s*\{[^}]*renderEmailFrame[^}]*\}\s*from\s*["'][^"']*email-frame\.ts["']/, `${file}: shared envelope imported`);
    assert.match(source, /renderEmailFrame\(\{/, `${file}: shared envelope used`);
    assert.doesNotMatch(source, /display\s*:\s*(?:flex|grid)/i, `${file}: no layout CSS unsupported by email clients`);
  }
  const { renderEmailFrame } = await importTypescriptModule(path.join(root, 'supabase/functions/_shared/email-frame.ts'));
  for (const lang of ['en', 'fr']) {
    const html = renderEmailFrame({ title: 'Title', heading: 'Heading', preheader: 'Preview', bodyHtml: '<p>Message</p>', lang, cta: { label: 'Open', url: 'https://norva.tv' } });
    assert.match(html, new RegExp(`<html lang="${lang}" dir="ltr">`));
    assert.match(html, /x-apple-disable-message-reformatting/);
    assert.match(html, /format-detection[^>]*telephone=no,date=no,address=no,email=no,url=no/);
    assert.match(html, /name="color-scheme" content="dark"/);
    assert.match(html, /name="supported-color-schemes" content="dark"/);
    assert.match(html, /data-preheader="true"/);
    assert.match(html, /role="presentation"/);
    assert.match(html, /bgcolor="#080B12"/);
    assert.match(html, /mso-padding-alt:16px 24px/);
    assert.doesNotMatch(html, /display\s*:\s*(?:flex|grid)/i);
  }
});

test('customer-facing support copy remains English while the internal support notification is explicitly French', () => {
  const source = read('supabase/functions/norva-support/index.ts');
  const customer = source.slice(source.indexOf('function supportClientEmail'), source.indexOf('function redactDiagnostic'));
  const inbox = source.slice(source.indexOf('function supportInboxEmail'), source.indexOf('function supportClientEmail'));
  assert.match(customer, /shell\("We replied to your support request"/);
  assert.doesNotMatch(customer, /,\s*"fr"\s*\)/);
  assert.match(inbox, /,\s*"fr"\s*\)/);
});

test('database-rendered security and trial mail is hardened by a forward migration', () => {
  const sql = read('supabase/migrations/20260722005300_branded_email_client_hardening.sql');
  assert.match(sql, /create or replace function public\.norva_branded_email_html/);
  assert.match(sql, /<html lang="en" dir="ltr">/);
  assert.match(sql, /x-apple-disable-message-reformatting/);
  assert.match(sql, /format-detection/);
  assert.match(sql, /data-preheader="true"/);
  assert.match(sql, /role="presentation"/);
  assert.match(sql, /mso-padding-alt:14px 30px/);
  assert.match(sql, /public\.norva_html_escape\(p_heading\)/);
  assert.match(sql, /public\.norva_html_escape\(p_cta_url\)/);
  assert.match(sql, /public\.norva_html_escape\(p_cta_label\)/);
  assert.match(sql, /public\.norva_html_escape\(p_footer\)/);
});

test('the locale contract does not pretend to localize the English-only customer template set', () => {
  const imports = read('supabase/functions/norva-import-notify/index.ts');
  const auth = read('supabase/functions/norva-auth-email/index.ts');
  const migration = read('supabase/migrations/20260722005300_branded_email_client_hardening.sql');
  assert.match(imports, /English-only \(Norva is English-only\)/);
  assert.match(auth, /Authentication copy is currently English-only/);
  assert.match(migration, /active copy set is English-only/);
});
