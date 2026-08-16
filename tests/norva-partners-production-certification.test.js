const test = require('node:test');
const assert = require('node:assert/strict');
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

test('the restore runbook describes the exact post-9961726 financial-canary contract', () => {
  const restore = read('ops/hetzner/backup/RESTORE.md');

  assert.match(restore, /20260812122425_partners_financial_canary_atomic_cycle\.sql/);
  assert.match(restore, /`baseline_contract=9961726`/);
  assert.match(restore, /`baseline_markers_verified=47`/);
  assert.match(restore, /`migrations_applied=1`/);
  assert.match(restore, /`migration_routines_verified=184`/);
  assert.match(restore, /`migration_relations_verified=20`/);
  assert.match(restore, /129 assertions pgTAP/);
});

test('the app cache-busts the finalized Partners API and page contracts', () => {
  const app = read('public/app.html');

  assert.match(app, /\/js\/cloudApi\.js\?v=65/);
  assert.match(app, /\/js\/pages\/PartnersPage\.js\?v=10/);
});

test('the historical Web tax policy evidence remains immutable', () => {
  const policy = read('docs/NORVA-PARTNERS-TAX-OPERATING-POLICY.md');
  const migration = read('supabase/migrations/20260805142422_partners_web_tax_contract.sql');

  assert.match(
    migration,
    /'partners-tax-operating-policy-2026-08-05-v2'[\s\S]*'2d63bea3bba420065eb930b6729f53fca257d4307be1bb524caf18174952c261'/,
  );
  assert.match(policy, /preuve\s+historique scellée/i);
  assert.match(policy, /ne doit jamais être réécrite/i);
  assert.match(policy, /franchise\s+en base/i);
  assert.match(policy, /partners_earnings_enabled=false/);
  assert.match(migration, /'FR'[\s\S]*'USD'[\s\S]*'gross_is_net'[\s\S]*0/);
});
