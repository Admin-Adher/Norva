const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

const edgeRenderers = [
  'supabase/functions/_shared/import-email.ts',
  'supabase/functions/_shared/lifecycle-email.ts',
  'supabase/functions/_shared/subtitle-ready-email.ts',
  'supabase/functions/norva-auth-email/index.ts',
  'supabase/functions/norva-account-delete/index.ts',
  'supabase/functions/norva-support/index.ts',
];

test('every active Edge email renderer declares a truthful locale and conservative client envelope', () => {
  for (const file of edgeRenderers) {
    const source = read(file);
    assert.match(source, /<html lang=(?:"en"|"\$\{lang\}") dir="ltr">/, `${file}: explicit LTR locale`);
    assert.match(source, /x-apple-disable-message-reformatting/, `${file}: Apple reformat guard`);
    assert.match(source, /format-detection[^>]*telephone=no,date=no,address=no,email=no,url=no/, `${file}: auto-link guard`);
    assert.match(source, /name="color-scheme" content="dark"/, `${file}: dark-mode contract`);
    assert.match(source, /name="supported-color-schemes" content="dark"/, `${file}: supported dark-mode contract`);
    assert.match(source, /data-preheader="true"/, `${file}: bounded preheader`);
    assert.match(source, /role="presentation"/, `${file}: presentation tables`);
    assert.match(source, /bgcolor="#0a0c11"/, `${file}: legacy-client background fallback`);
    assert.doesNotMatch(source, /display\s*:\s*(?:flex|grid)/i, `${file}: no layout CSS unsupported by email clients`);
  }
  assert.match(read('supabase/functions/norva-auth-email/index.ts'), /mso-padding-alt:14px 30px/);
  assert.match(read('supabase/functions/norva-support/index.ts'), /mso-padding-alt:14px 30px/);
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
