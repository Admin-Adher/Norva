const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const legalPages = [
  'public/mentions-legales.html',
  'public/terms.html',
  'public/privacy.html',
  'public/partners-terms.html',
];

test('public legal pages identify the current Norva SASU consistently', () => {
  for (const file of legalPages) {
    const source = read(file);
    const visibleText = source
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
    assert.match(source, /108(?:&nbsp;|\s)+055(?:&nbsp;|\s)+237/);
    assert.match(
      source,
      /108(?:&nbsp;|\s)+055(?:&nbsp;|\s)+237(?:&nbsp;|\s)+00011/,
    );
    assert.match(source, /société par actions simplifiée\s+unipersonnelle/);
    assert.match(source, /Adrien Hernandez/);
    assert.match(visibleText, /share capital EUR 100/);
    assert.doesNotMatch(source, /FR65(?:&nbsp;|\s)*108055237/);
    assert.doesNotMatch(source, /EU VAT number/i);
    assert.doesNotMatch(source, /824(?:&nbsp;|\s)+852(?:&nbsp;|\s)+081/);
    assert.doesNotMatch(source, /sole trader|entrepreneur individuel/i);
  }
});

test('legal notice describes the current self-hosted infrastructure', () => {
  const source = read('public/mentions-legales.html');
  assert.match(source, /Hetzner Online GmbH/);
  assert.match(source, /Supabase does not host this\s+deployment/);
  assert.doesNotMatch(source, /hosted[^.]+by <strong>Supabase, Inc\.<\/strong>/i);
  assert.doesNotMatch(source, /Railway Corp\./);
});

test('tax operating documents do not treat the former sole-trader regime as current', () => {
  const vatRunbook = read('docs/TVA-OSS.md');
  const partnersTaxPolicy = read(
    'docs/NORVA-PARTNERS-TAX-OPERATING-POLICY.md',
  );
  assert.match(vatRunbook, /Situation au 9 août 2026\s*:\s*\*\*Norva SASU\*\*/);
  assert.match(vatRunbook, /Non applicable à Norva SASU/);
  assert.doesNotMatch(vatRunbook, /Situation\s*:\s*EI\/micro-entrepreneur/i);
  assert.match(
    partnersTaxPolicy,
    /synthèse définitive validée[\s\S]*Franchise en base TVA/,
  );
  assert.match(
    partnersTaxPolicy,
    /df30b003e440f8c49f10dd71109a0b7267e0c11739e04bec8ce4979d0c9804dc/,
  );
  assert.match(partnersTaxPolicy, /il ne\s+s'agit plus d'une hypothèse/i);
  assert.doesNotMatch(
    partnersTaxPolicy,
    /Sans cette\s+preuve, `partners_earnings_enabled` reste à `false`/,
  );
});
