const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('Partners production certification keeps all twelve controls explicit', () => {
  const certification = read('docs/NORVA-PARTNERS-PRODUCTION-CERTIFICATION-12.md');
  const rows = certification.match(/^\|\s*(?:[1-9]|1[0-2])\s*\|/gm) || [];

  assert.equal(rows.length, 12);
  assert.match(certification, /external_professional_review_obtained=false/);
  assert.match(certification, /acceptation de risque propriétaire/i);
  assert.match(certification, /sans Didit, profil fiscal cash ou banque/i);
  assert.match(certification, /session live contrôlée avec une vraie personne consentante/i);
  assert.match(certification, /deux opérateurs Finance humains AAL2 distincts/i);
  assert.match(certification, /au moins 45 jours observés/i);
  assert.doesNotMatch(certification, /avis professionnel (?:obtenu|validé)/i);
});

test('the restore runbook describes the exact three-migration candidate contract', () => {
  const restore = read('ops/hetzner/backup/RESTORE.md');

  assert.match(restore, /20260805124714_partners_owner_legal_tax_risk_acceptance\.sql/);
  assert.match(restore, /20260805142416_partners_multicurrency_access_credits\.sql/);
  assert.match(restore, /20260805142422_partners_web_tax_contract\.sql/);
  assert.match(restore, /`migrations_applied=3`/);
  assert.match(restore, /`migration_routines_verified=162`/);
  assert.match(restore, /`migration_relations_verified=19`/);
});

test('the app cache-busts the finalized Partners API and page contracts', () => {
  const app = read('public/app.html');

  assert.match(app, /\/js\/cloudApi\.js\?v=59/);
  assert.match(app, /\/js\/pages\/PartnersPage\.js\?v=8/);
});

test('the active Web tax policy seals the exact internal tax evidence', () => {
  const policy = read('docs/NORVA-PARTNERS-TAX-OPERATING-POLICY.md');
  const migration = read('supabase/migrations/20260805142422_partners_web_tax_contract.sql');
  const digest = crypto.createHash('sha256').update(policy).digest('hex');

  assert.match(migration, new RegExp(digest));
  assert.match(policy, /franchise en base de TVA/i);
  assert.match(policy, /partners_earnings_enabled=false/);
  assert.match(migration, /'FR'[\s\S]*'USD'[\s\S]*'gross_is_net'[\s\S]*0/);
});
