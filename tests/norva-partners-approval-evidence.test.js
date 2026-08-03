'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  evaluateApprovalPackage,
  validateApprovalPackage,
} = require('../scripts/validate-partners-approval-evidence.js');

const root = path.join(__dirname, '..');
const validator = path.join(
  root,
  'scripts',
  'validate-partners-approval-evidence.js',
);
const template = JSON.parse(fs.readFileSync(
  path.join(root, 'ops/partners/approval-evidence.example.json'),
  'utf8',
));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function evidenceRef(key, verifiedAt) {
  return {
    url: `https://evidence.norva.tv/partners/approvals/${key}.json`,
    run_id: `approval:${key}-20260803-001`,
    sha256: sha256(`approval:${key}`),
    verified_at: verifiedAt,
  };
}

function readyPackage() {
  const value = clone(template);
  value.status = 'approved';
  value.candidate_commit_sha = sha256('candidate').slice(0, 40);
  value.target_environment = 'production';
  value.deployment_id = 'cloudflare:partners-20260803-001';
  value.program.version_key = 'individual-global-p0-v2';
  value.jurisdiction.policy_key = 'fr-individual-p0-v1';
  value.jurisdiction.individual_available = true;
  value.jurisdiction.effective_from = '2026-08-03T08:00:00Z';
  value.documents = {
    partners_terms_version: 'partners-terms-v1',
    partners_terms_sha256: sha256('partners-terms-v1'),
    disclosure_version: 'partners-disclosure-v1',
    disclosure_sha256: sha256('partners-disclosure-v1'),
    privacy_version: 'privacy-v2',
    privacy_sha256: sha256('privacy-v2'),
    public_surfaces: {
      verified_at: '2026-08-03T09:00:00Z',
      hash_basis: 'normalized_deployment_artifact',
      deployment_evidence: evidenceRef(
        'public-deployment',
        '2026-08-03T08:55:00Z',
      ),
      terms_evidence: evidenceRef(
        'public-terms',
        '2026-08-03T08:56:00Z',
      ),
      privacy_evidence: evidenceRef(
        'public-privacy',
        '2026-08-03T08:57:00Z',
      ),
      partners_terms_evidence: evidenceRef(
        'public-partners-terms',
        '2026-08-03T08:58:00Z',
      ),
    },
  };
  value.dependencies = {
    configuration_snapshot_evidence: evidenceRef(
      'configuration-snapshot',
      '2026-08-03T09:05:00Z',
    ),
    didit_live_evidence: evidenceRef(
      'didit-live',
      '2026-08-03T09:10:00Z',
    ),
    payout_corridor_evidence: evidenceRef(
      'payout-corridor',
      '2026-08-03T09:15:00Z',
    ),
    exact_financial_data_evidence: evidenceRef(
      'exact-financial-data',
      '2026-08-03T09:20:00Z',
    ),
  };
  const legal = value.decisions.legal_and_tax;
  legal.approved = true;
  legal.decided_at = '2026-08-03T09:30:00Z';
  legal.reviewer_reference_sha256 = sha256('legal-reviewer-reference');
  legal.evidence = evidenceRef('legal-decision', '2026-08-03T09:31:00Z');
  Object.keys(legal.checks).forEach((key) => { legal.checks[key] = true; });
  const privacy = value.decisions.privacy;
  privacy.approved = true;
  privacy.decided_at = '2026-08-03T09:35:00Z';
  privacy.reviewer_reference_sha256 = sha256('privacy-reviewer-reference');
  privacy.evidence = evidenceRef(
    'privacy-decision',
    '2026-08-03T09:36:00Z',
  );
  Object.keys(privacy.checks).forEach((key) => {
    privacy.checks[key] = true;
  });
  const country = value.decisions.country_policy;
  country.approved = true;
  country.decided_at = '2026-08-03T09:40:00Z';
  country.reviewer_reference_sha256 = sha256('risk-reviewer-reference');
  country.evidence = evidenceRef('country-decision', '2026-08-03T09:41:00Z');
  Object.keys(country.checks).forEach((key) => {
    country.checks[key] = true;
  });
  return value;
}

test('approval evidence template is strict, valid and fail-closed', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'partners-integration.yml'),
    'utf8',
  );
  const result = evaluateApprovalPackage(template, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(result.blockers.legal_and_tax.includes('legal_and_tax_not_approved'));
  assert.ok(result.blockers.privacy.includes('privacy_not_approved'));
  assert.ok(result.blockers.country_policy.includes('country_policy_not_approved'));
  assert.match(workflow, /scripts\/validate-partners-\*\.js/);
  assert.match(
    workflow,
    /validate-partners-approval-evidence\.js[\s\S]*approval-evidence\.example\.json/,
  );
});

test('a complete approval package passes all three decisions', () => {
  const result = evaluateApprovalPackage(readyPackage(), {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.deepEqual(result.blockers, {
    legal_and_tax: [],
    privacy: [],
    country_policy: [],
  });
});

test('unknown fields and personal identifiers fail closed', () => {
  const unknown = readyPackage();
  unknown.decisions.privacy.free_text = 'approved';
  assert.throws(() => validateApprovalPackage(unknown), /must contain exactly/);

  const personal = readyPackage();
  personal.dependencies.didit_live_evidence.url =
    'https://evidence.norva.tv/partners/person@norva.tv.json';
  assert.throws(() => validateApprovalPackage(personal), /must not contain an email/);
});

test('a checked box cannot replace reviewer and immutable evidence', () => {
  const value = readyPackage();
  value.decisions.legal_and_tax.reviewer_reference_sha256 = null;
  value.decisions.legal_and_tax.evidence = null;
  const result = evaluateApprovalPackage(value, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(result.blockers.legal_and_tax.includes(
    'legal_and_tax_reviewer_reference_missing',
  ));
  assert.ok(result.blockers.legal_and_tax.includes(
    'legal_and_tax_evidence_missing',
  ));
});

test('country approval must follow every authoritative dependency', () => {
  const value = readyPackage();
  value.decisions.country_policy.decided_at = '2026-08-03T09:15:00Z';
  value.decisions.country_policy.evidence.verified_at =
    '2026-08-03T09:41:00Z';
  const result = evaluateApprovalPackage(value, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(result.blockers.country_policy.includes(
    'country_policy_decision_predates_dependencies',
  ));
});

test('Legal and Privacy decisions must follow the deployed public surfaces', () => {
  const value = readyPackage();
  value.documents.public_surfaces.verified_at =
    '2026-08-03T09:34:00Z';
  const result = evaluateApprovalPackage(value, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(result.blockers.legal_and_tax.includes(
    'legal_and_tax_decision_predates_public_surfaces',
  ));
  assert.ok(!result.blockers.privacy.includes(
    'privacy_decision_predates_public_surfaces',
  ));
});

test('CLI refuses --require-all for a draft and accepts the complete package', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'norva-approval-'));
  const draftFile = path.join(directory, 'draft.json');
  const readyFile = path.join(directory, 'ready.json');
  fs.writeFileSync(draftFile, JSON.stringify(template));
  const ready = readyPackage();
  fs.writeFileSync(readyFile, JSON.stringify(ready));

  const draft = spawnSync(process.execPath, [
    validator,
    draftFile,
    '--require-all',
  ], { encoding: 'utf8' });
  assert.equal(draft.status, 1);
  assert.match(draft.stderr, /--expected-commit-sha is required/);

  const accepted = spawnSync(process.execPath, [
    validator,
    readyFile,
    '--require-all',
    `--expected-commit-sha=${ready.candidate_commit_sha}`,
  ], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, /"status": "approved"/);
});
