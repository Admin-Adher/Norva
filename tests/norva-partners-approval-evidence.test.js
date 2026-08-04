'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  MEMBERSHIP_PRIVACY_CHECKS,
  PRIVACY_CHECKS,
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
    membership_privacy_notice_evidence: evidenceRef(
      'membership-privacy-notice',
      '2026-08-03T09:05:00Z',
    ),
    membership_ropa_evidence: evidenceRef(
      'membership-ropa',
      '2026-08-03T09:06:00Z',
    ),
    membership_minimization_evidence: evidenceRef(
      'membership-minimization',
      '2026-08-03T09:07:00Z',
    ),
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
  const membershipPrivacy = value.decisions.membership_privacy;
  membershipPrivacy.approved = true;
  membershipPrivacy.decided_at = '2026-08-03T09:25:00Z';
  membershipPrivacy.notice_version = 'membership-privacy-v1';
  membershipPrivacy.notice_sha256 = sha256('membership-privacy-v1');
  membershipPrivacy.ropa_version = 'membership-ropa-v1';
  membershipPrivacy.ropa_sha256 = sha256('membership-ropa-v1');
  membershipPrivacy.minimization_review_version = 'membership-minimization-v1';
  membershipPrivacy.minimization_review_sha256 = sha256(
    'membership-minimization-v1',
  );
  membershipPrivacy.reviewer_reference_sha256 = sha256(
    'membership-privacy-reviewer-reference',
  );
  membershipPrivacy.evidence = evidenceRef(
    'membership-privacy-decision',
    '2026-08-03T09:26:00Z',
  );
  Object.keys(membershipPrivacy.checks).forEach((key) => {
    membershipPrivacy.checks[key] = true;
  });
  const privacy = value.decisions.privacy;
  privacy.approved = true;
  privacy.decided_at = '2026-08-03T09:35:00Z';
  privacy.reviewer_reference_sha256 = sha256('privacy-reviewer-reference');
  privacy.evidence = evidenceRef(
    'privacy-decision',
    '2026-08-03T09:36:00Z',
  );
  privacy.dpia_outcome = 'residual_risk_acceptable';
  privacy.dpia_controller_validated_at = '2026-08-03T09:33:00Z';
  privacy.dpia_evidence = evidenceRef(
    'privacy-dpia',
    '2026-08-03T09:34:00Z',
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
  assert.ok(result.blockers.membership_privacy.includes(
    'membership_privacy_not_approved',
  ));
  assert.ok(result.blockers.privacy.includes('privacy_not_approved'));
  assert.ok(result.blockers.country_policy.includes('country_policy_not_approved'));
  assert.match(workflow, /scripts\/validate-partners-\*\.js/);
  assert.match(
    workflow,
    /validate-partners-approval-evidence\.js[\s\S]*approval-evidence\.example\.json/,
  );
  assert.equal(template.schema_version, 4);
  assert.equal(template.target_environment, 'preproduction');
  assert.deepEqual(template.release_scope, {
    membership_access_mode: 'public',
    membership_public_release_eligible: true,
    cash_access_mode: 'allowlist_only',
    cash_country_code: 'FR',
    cash_participant_cap: 50,
    cash_public_release_eligible: false,
  });
  assert.equal(
    template.decisions.membership_privacy.assessment_method,
    'documented_membership_privacy_assessment',
  );
  assert.equal(
    template.decisions.membership_privacy.approval_control,
    'risk_aal2',
  );
  assert.equal(
    template.decisions.privacy.assessment_method,
    'documented_internal_gdpr_self_assessment_with_mandatory_dpia',
  );
  assert.equal(template.decisions.privacy.dpo_designated, false);
  assert.equal(template.decisions.privacy.dpia_required, true);
  assert.equal(template.decisions.privacy.dpia_outcome, 'pending');
  assert.equal(template.decisions.privacy.dpia_evidence, null);
  assert.equal(template.decisions.privacy.public_release_eligible, false);

  const sandboxDeployment = clone(template);
  sandboxDeployment.target_environment = 'sandbox';
  assert.throws(
    () => validateApprovalPackage(sandboxDeployment),
    /target_environment must be preproduction or production/,
  );
});

test('a complete approval package passes all four decisions', () => {
  const result = evaluateApprovalPackage(readyPackage(), {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.deepEqual(result.blockers, {
    legal_and_tax: [],
    membership_privacy: [],
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

test('Privacy remains blocked without a completed, controller-validated DPIA', () => {
  const missing = readyPackage();
  missing.decisions.privacy.dpia_outcome = 'pending';
  missing.decisions.privacy.dpia_controller_validated_at = null;
  missing.decisions.privacy.dpia_evidence = null;
  const missingResult = evaluateApprovalPackage(missing, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(missingResult.blockers.privacy.includes('privacy_dpia_pending'));
  assert.ok(missingResult.blockers.privacy.includes(
    'privacy_dpia_controller_validation_invalid',
  ));
  assert.ok(missingResult.blockers.privacy.includes(
    'privacy_dpia_evidence_missing',
  ));

  const consultation = readyPackage();
  consultation.decisions.privacy.dpia_outcome =
    'prior_consultation_required';
  const consultationResult = evaluateApprovalPackage(consultation, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(consultationResult.blockers.privacy.includes(
    'privacy_dpia_prior_consultation_required',
  ));
});

test('membership is public while the France cash pilot remains allowlist-only', () => {
  const inviteMembership = readyPackage();
  inviteMembership.release_scope.membership_access_mode = 'invite_only';
  assert.throws(
    () => validateApprovalPackage(inviteMembership),
    /release_scope\.membership_access_mode must remain public/,
  );

  const publicCash = readyPackage();
  publicCash.release_scope.cash_access_mode = 'public';
  publicCash.release_scope.cash_public_release_eligible = true;
  publicCash.decisions.privacy.public_release_eligible = true;
  assert.throws(
    () => validateApprovalPackage(publicCash),
    /release_scope\.cash_access_mode must remain allowlist_only/,
  );

  const designatedDpo = readyPackage();
  designatedDpo.decisions.privacy.reviewer_role = 'privacy_professional';
  designatedDpo.decisions.privacy.dpo_designated = true;
  assert.throws(
    () => validateApprovalPackage(designatedDpo),
    /reviewer_role must be privacy_accountable_owner/,
  );

  const wrongCountry = readyPackage();
  wrongCountry.jurisdiction.country_code = 'BE';
  assert.throws(
    () => validateApprovalPackage(wrongCountry),
    /jurisdiction\.country_code must match release_scope\.cash_country_code/,
  );
});

test('membership Privacy can be approved before the cash Didit DPIA', () => {
  const value = readyPackage();
  value.decisions.privacy.approved = false;
  value.decisions.privacy.dpia_outcome = 'pending';
  value.decisions.privacy.dpia_controller_validated_at = null;
  value.decisions.privacy.dpia_evidence = null;
  const result = evaluateApprovalPackage(value, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.deepEqual(result.blockers.membership_privacy, []);
  assert.ok(result.blockers.privacy.includes('privacy_not_approved'));
  assert.ok(result.blockers.privacy.includes('privacy_dpia_pending'));
});

test('membership Privacy requires versioned notice, ROPA and minimization evidence', () => {
  const value = readyPackage();
  value.decisions.membership_privacy.notice_version = null;
  value.dependencies.membership_ropa_evidence = null;
  const result = evaluateApprovalPackage(value, {
    nowMs: Date.parse('2026-08-03T10:00:00Z'),
  });
  assert.ok(result.blockers.membership_privacy.includes(
    'membership_privacy_artifacts_not_versioned',
  ));
  assert.ok(result.blockers.membership_privacy.includes(
    'membership_ropa_evidence_missing',
  ));
});

test('the GDPR self-assessment template mirrors every privacy control and AAL2', () => {
  const selfAssessment = fs.readFileSync(
    path.join(root, 'ops/partners/gdpr-self-assessment.example.md'),
    'utf8',
  );
  for (const check of PRIVACY_CHECKS) {
    assert.match(selfAssessment, new RegExp(`\\b${check}\\b`));
  }
  assert.match(selfAssessment, /privacy_accountable_owner/);
  assert.match(selfAssessment, /aucune désignation officielle de DPO/i);
  assert.match(selfAssessment, /AIPD\/DPIA obligatoire/i);
  assert.match(selfAssessment, /données sensibles ou hautement personnelles/i);
  assert.match(selfAssessment, /exclusion du bénéfice d'un droit,[\s\S]*d'un contrat/i);
  assert.match(selfAssessment, /parcours optionnel de virement/i);
  assert.match(selfAssessment, /L'adhésion Partners,[\s\S]*ne requièrent ni KYC/i);
  assert.match(selfAssessment, /conversion irréversible du solde disponible[\s\S]*sans transfert[\s\S]*qualification juridique/i);
  assert.doesNotMatch(selfAssessment, /(?:n'est|ni) monnaie électronique/i);
  assert.match(selfAssessment, /retrait bloque uniquement une nouvelle vérification[\s\S]*ne bloque jamais l'adhésion/i);
  assert.match(selfAssessment, /nécessité et proportionnalité/i);
  assert.match(selfAssessment, /risques pour les droits et libertés/i);
  assert.match(selfAssessment, /consultation préalable de la CNIL/i);
  assert.match(selfAssessment, /ce modèle ne fabrique ni sa décision, ni sa signature/i);
  assert.match(selfAssessment, /https:\/\/www\.cnil\.fr\/fr\/ce-quil-faut-savoir/);
  assert.match(selfAssessment, /JWT[\s\S]*AAL2/);
  assert.match(selfAssessment, /stockage privé immuable/);
});

test('membership Privacy checks exclude Didit and use Risk plus AAL2 approval', () => {
  const packageDecision = template.decisions.membership_privacy;
  assert.deepEqual(
    Object.keys(packageDecision.checks),
    MEMBERSHIP_PRIVACY_CHECKS,
  );
  assert.equal(packageDecision.approval_control, 'risk_aal2');
  assert.equal(
    packageDecision.checks.didit_biometric_and_payout_data_excluded,
    false,
  );
  assert.equal(Object.hasOwn(packageDecision, 'dpia_required'), false);
  assert.equal(Object.hasOwn(packageDecision, 'dpia_evidence'), false);
});

test('approval guidance keeps payout evidence out of frictionless membership', () => {
  const guidance = fs.readFileSync(
    path.join(root, 'docs/NORVA-PARTNERS-APPROVAL-EVIDENCE.md'),
    'utf8',
  );
  assert.match(guidance, /L'adhésion, le lien, l'attribution,[\s\S]*ne requièrent ni KYC\/Didit/i);
  assert.match(guidance, /preuves Didit, fiscales et corridor[\s\S]*virement cash/i);
  assert.match(guidance, /conversion irréversible d'un solde disponible en accès Norva/i);
  assert.match(guidance, /description factuelle ne préjuge pas de sa[\s\S]*qualification juridique/i);
  assert.doesNotMatch(guidance, /(?:n'est|ni) monnaie électronique/i);
  assert.match(guidance, /retrait du consentement biométrique[\s\S]*ne bloque\s+pas la conversion/i);
  assert.match(guidance, /dpo_designated=false/);
  assert.match(guidance, /AIPD[\s\S]*avant d'activer Didit pour un virement/i);
  assert.match(
    guidance,
    /membership_privacy_approved[\s\S]*notice[\s\S]*ROPA[\s\S]*minimisation/i,
  );
  assert.match(
    guidance,
    /privacy_approved[\s\S]*pilote cash France sur allowlist/i,
  );
  assert.doesNotMatch(guidance, /conditionne l'accès au programme Partners/i);
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
