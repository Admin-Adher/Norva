#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ISO_COUNTRIES,
  ISO_CURRENCIES,
  NON_PAYOUT_CURRENCIES,
  isEvidenceReference,
} = require('./validate-partners-release-evidence.js');

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const VERSION_KEY = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const REPOSITORY = 'Admin-Adher/Norva';

const LEGAL_CHECKS = [
  'individual_program_scope_approved',
  'recurring_commission_model_approved',
  'attribution_and_maturation_rules_approved',
  'threshold_and_fee_policy_approved',
  'individual_tax_reporting_approved',
  'sanctions_and_restricted_destinations_reviewed',
  'terms_and_disclosure_approved',
  'kyc_only_without_kyb_scope_approved',
  'refund_chargeback_and_reversal_rules_approved',
];
const PRIVACY_CHECKS = [
  'gdpr_self_assessment_documented',
  'records_of_processing_documented',
  'data_inventory_and_purposes_approved',
  'lawful_bases_approved',
  'subprocessor_disclosures_approved',
  'international_transfers_approved',
  'retention_and_deletion_schedule_approved',
  'data_subject_rights_flow_approved',
  'data_minimization_and_redaction_approved',
  'kyc_and_payout_notices_approved',
  'public_privacy_notice_approved',
  'security_incident_notification_flow_approved',
  'dpo_mandatoriness_assessed',
  'dpia_processing_and_purposes_documented',
  'dpia_necessity_and_proportionality_assessed',
  'dpia_risks_to_rights_and_freedoms_assessed',
  'dpia_safeguards_and_residual_risk_assessed',
  'dpia_controller_validation_recorded',
  'dpia_prior_consultation_determined',
  'pilot_scope_and_reassessment_triggers_approved',
];
const COUNTRY_CHECKS = [
  'legal_and_tax_dependency_approved',
  'privacy_dependency_approved',
  'minimum_age_and_capacity_rule_approved',
  'didit_live_coverage_approved',
  'payout_corridor_and_currency_approved',
  'exact_financial_data_coverage_approved',
  'sanctions_and_restricted_destinations_reviewed',
  'terms_and_disclosure_versions_match',
  'pilot_allowlist_scope_approved',
  'effective_dates_approved',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, keys, trail) {
  assert(value && typeof value === 'object' && !Array.isArray(value),
    `${trail} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    `${trail} must contain exactly: ${expected.join(', ')}`,
  );
}

function isStrongSha256(value) {
  return typeof value === 'string'
    && SHA256.test(value)
    && !/^([a-f0-9])\1{63}$/.test(value);
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertOptionalTimestamp(value, trail) {
  assert(value === null || parseTimestamp(value) !== null,
    `${trail} must be null or an ISO UTC timestamp`);
}

function assertOptionalVersion(value, trail) {
  assert(value === null || VERSION_KEY.test(value),
    `${trail} must be null or a version key`);
}

function assertOptionalSha(value, trail) {
  assert(value === null || isStrongSha256(value),
    `${trail} must be null or a strong SHA-256`);
}

function evidenceIdentity(reference) {
  return [
    reference.url,
    reference.run_id,
    reference.sha256,
    reference.verified_at,
  ].join('|');
}

function assertOptionalEvidence(value, trail, nowMs) {
  assert(value === null || isEvidenceReference(value, nowMs),
    `${trail} must be null or a strict immutable evidence reference`);
}

function validateChecks(value, keys, trail) {
  assertExactKeys(value, keys, trail);
  for (const key of keys) {
    assert(typeof value[key] === 'boolean', `${trail}.${key} must be boolean`);
  }
}

function validateDecision(value, key, role, checks, nowMs, options = {}) {
  const trail = `decisions.${key}`;
  const extraKeys = options.extraKeys || [];
  assertExactKeys(value, [
    'approved',
    'checks',
    'decided_at',
    'evidence',
    'reviewer_reference_sha256',
    'reviewer_role',
    'valid_until',
    ...extraKeys,
  ], trail);
  assert(typeof value.approved === 'boolean', `${trail}.approved must be boolean`);
  assert(value.reviewer_role === role,
    `${trail}.reviewer_role must be ${role}`);
  assertOptionalTimestamp(value.decided_at, `${trail}.decided_at`);
  assertOptionalTimestamp(value.valid_until, `${trail}.valid_until`);
  assertOptionalSha(
    value.reviewer_reference_sha256,
    `${trail}.reviewer_reference_sha256`,
  );
  assertOptionalEvidence(value.evidence, `${trail}.evidence`, nowMs);
  validateChecks(value.checks, checks, `${trail}.checks`);
  if (options.validateExtra) options.validateExtra(value, trail);
}

function validateApprovalPackage(value, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  assertExactKeys(value, [
    'candidate_commit_sha',
    'contains_personal_data',
    'decisions',
    'dependencies',
    'deployment_id',
    'documents',
    'jurisdiction',
    'package_key',
    'program',
    'repository',
    'release_scope',
    'schema_version',
    'status',
    'target_environment',
  ], 'approval package');
  assert(value.schema_version === 3, 'schema_version must be 3');
  assert(['draft', 'approved'].includes(value.status),
    'status must be draft or approved');
  assert(VERSION_KEY.test(value.package_key || ''),
    'package_key must be versioned');
  assert(value.repository === REPOSITORY,
    `repository must be ${REPOSITORY}`);
  assert(value.candidate_commit_sha === null
    || COMMIT_SHA.test(value.candidate_commit_sha),
  'candidate_commit_sha must be null or 40 lowercase hex characters');
  assert(value.deployment_id === null
    || DEPLOYMENT_ID.test(value.deployment_id),
  'deployment_id must be null or an opaque deployment identifier');
  assert(['preproduction', 'production'].includes(value.target_environment),
    'target_environment must be preproduction or production');
  assert(value.contains_personal_data === false,
    'contains_personal_data must remain false');

  assertExactKeys(value.release_scope, [
    'access_mode',
    'country_code',
    'participant_cap',
    'public_release_eligible',
  ], 'release_scope');
  assert(value.release_scope.access_mode === 'invite_only',
    'release_scope.access_mode must remain invite_only');
  assert(value.release_scope.country_code === 'FR',
    'release_scope.country_code must remain FR for this pilot contract');
  assert(value.release_scope.participant_cap === 50,
    'release_scope.participant_cap must remain 50');
  assert(value.release_scope.public_release_eligible === false,
    'internal self-assessment must never authorize a public release');

  assertExactKeys(value.program, [
    'account_type',
    'attribution_window_days',
    'commission_duration',
    'commission_rate_bps',
    'maturation_days',
    'payout_fee_policy',
    'threshold_reference_currency',
    'threshold_reference_minor',
    'version_key',
  ], 'program');
  assertOptionalVersion(value.program.version_key, 'program.version_key');
  assert(value.program.account_type === 'individual',
    'program.account_type must be individual');
  assert(value.program.commission_rate_bps === 2000,
    'program.commission_rate_bps must be 2000');
  assert(value.program.attribution_window_days === 30,
    'program.attribution_window_days must be 30');
  assert(value.program.maturation_days === 45,
    'program.maturation_days must be 45');
  assert(value.program.commission_duration
    === 'while_referred_subscription_active',
  'program.commission_duration must preserve the approved recurring scope');
  assert(value.program.payout_fee_policy === 'platform_absorbed',
    'program.payout_fee_policy must be platform_absorbed');
  assert(value.program.threshold_reference_currency === 'USD'
    && value.program.threshold_reference_minor === 1000,
  'program threshold reference must be exactly USD 1000 minor units');

  assertExactKeys(value.jurisdiction, [
    'capacity_required',
    'country_code',
    'effective_from',
    'individual_available',
    'minimum_age',
    'payout_currencies',
    'policy_key',
    'subdivision_code',
    'verification_level',
    'verification_provider',
  ], 'jurisdiction');
  assert(ISO_COUNTRIES.has(value.jurisdiction.country_code),
    'jurisdiction.country_code must be an assigned ISO country');
  assert(
    value.jurisdiction.subdivision_code === null
      || (
        typeof value.jurisdiction.subdivision_code === 'string'
        && value.jurisdiction.subdivision_code.length <= 12
        && value.jurisdiction.subdivision_code.startsWith(
          `${value.jurisdiction.country_code}-`,
        )
        && /^[A-Z]{2}-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(
          value.jurisdiction.subdivision_code,
        )
      ),
    'jurisdiction.subdivision_code must be null or country-prefixed ISO form',
  );
  assertOptionalVersion(value.jurisdiction.policy_key,
    'jurisdiction.policy_key');
  assert(Number.isSafeInteger(value.jurisdiction.minimum_age)
    && value.jurisdiction.minimum_age >= 18
    && value.jurisdiction.minimum_age <= 99,
  'jurisdiction.minimum_age must be between 18 and 99');
  assert(value.jurisdiction.capacity_required === true,
    'jurisdiction.capacity_required must be true');
  assert(value.jurisdiction.verification_provider === 'didit',
    'jurisdiction.verification_provider must be didit');
  assert(value.jurisdiction.verification_level
    === 'identity_age_country_capacity',
  'jurisdiction.verification_level is not the individual KYC contract');
  assert(Array.isArray(value.jurisdiction.payout_currencies)
    && value.jurisdiction.payout_currencies.length >= 1
    && value.jurisdiction.payout_currencies.length <= 10
    && new Set(value.jurisdiction.payout_currencies).size
      === value.jurisdiction.payout_currencies.length
    && value.jurisdiction.payout_currencies.every((currency) => (
      ISO_CURRENCIES.has(currency) && !NON_PAYOUT_CURRENCIES.has(currency)
    )),
  'jurisdiction.payout_currencies must be unique payout ISO currencies');
  assert(typeof value.jurisdiction.individual_available === 'boolean',
    'jurisdiction.individual_available must be boolean');
  assertOptionalTimestamp(value.jurisdiction.effective_from,
    'jurisdiction.effective_from');
  assert(value.jurisdiction.country_code === value.release_scope.country_code,
    'jurisdiction.country_code must match release_scope.country_code');

  assertExactKeys(value.documents, [
    'disclosure_sha256',
    'disclosure_version',
    'partners_terms_sha256',
    'partners_terms_version',
    'privacy_sha256',
    'privacy_version',
    'public_surfaces',
  ], 'documents');
  for (const field of [
    'disclosure_version',
    'partners_terms_version',
    'privacy_version',
  ]) assertOptionalVersion(value.documents[field], `documents.${field}`);
  for (const field of [
    'disclosure_sha256',
    'partners_terms_sha256',
    'privacy_sha256',
  ]) assertOptionalSha(value.documents[field], `documents.${field}`);
  assertExactKeys(value.documents.public_surfaces, [
    'deployment_evidence',
    'hash_basis',
    'partners_terms_evidence',
    'privacy_evidence',
    'terms_evidence',
    'verified_at',
  ], 'documents.public_surfaces');
  assert(value.documents.public_surfaces.hash_basis
    === 'normalized_deployment_artifact',
  'documents.public_surfaces.hash_basis must be normalized deployment output');
  assertOptionalTimestamp(
    value.documents.public_surfaces.verified_at,
    'documents.public_surfaces.verified_at',
  );
  for (const field of [
    'deployment_evidence',
    'terms_evidence',
    'privacy_evidence',
    'partners_terms_evidence',
  ]) {
    assertOptionalEvidence(
      value.documents.public_surfaces[field],
      `documents.public_surfaces.${field}`,
      nowMs,
    );
  }

  assertExactKeys(value.dependencies, [
    'configuration_snapshot_evidence',
    'didit_live_evidence',
    'exact_financial_data_evidence',
    'payout_corridor_evidence',
  ], 'dependencies');
  for (const [key, reference] of Object.entries(value.dependencies)) {
    assertOptionalEvidence(reference, `dependencies.${key}`, nowMs);
  }

  assertExactKeys(value.decisions, [
    'country_policy',
    'legal_and_tax',
    'privacy',
  ], 'decisions');
  validateDecision(
    value.decisions.legal_and_tax,
    'legal_and_tax',
    'legal_and_tax_professional',
    LEGAL_CHECKS,
    nowMs,
  );
  validateDecision(
    value.decisions.privacy,
    'privacy',
    'privacy_accountable_owner',
    PRIVACY_CHECKS,
    nowMs,
    {
      extraKeys: [
        'assessment_method',
        'dpo_designated',
        'dpia_controller_validated_at',
        'dpia_evidence',
        'dpia_outcome',
        'dpia_required',
        'public_release_eligible',
      ],
      validateExtra: (decision, trail) => {
        assert(
          decision.assessment_method
            === 'documented_internal_gdpr_self_assessment_with_mandatory_dpia',
          `${trail}.assessment_method must include the mandatory DPIA`,
        );
        assert(decision.dpo_designated === false,
          `${trail}.dpo_designated must remain false`);
        assert(decision.dpia_required === true,
          `${trail}.dpia_required must remain true`);
        assert([
          'pending',
          'residual_risk_acceptable',
          'prior_consultation_required',
        ].includes(decision.dpia_outcome),
        `${trail}.dpia_outcome is invalid`);
        assertOptionalTimestamp(
          decision.dpia_controller_validated_at,
          `${trail}.dpia_controller_validated_at`,
        );
        assertOptionalEvidence(
          decision.dpia_evidence,
          `${trail}.dpia_evidence`,
          nowMs,
        );
        assert(decision.public_release_eligible === false,
          `${trail}.public_release_eligible must remain false`);
      },
    },
  );
  validateDecision(
    value.decisions.country_policy,
    'country_policy',
    'risk_officer',
    COUNTRY_CHECKS,
    nowMs,
  );

  const serialized = JSON.stringify(value);
  assert(!EMAIL.test(serialized), 'approval package must not contain an email');
  assert(!UUID.test(serialized), 'approval package must not contain a UUID');
  assert(!IBAN.test(serialized), 'approval package must not contain an IBAN');

  const references = [
    ...[
      'deployment_evidence',
      'terms_evidence',
      'privacy_evidence',
      'partners_terms_evidence',
    ].map((field) => value.documents.public_surfaces[field]),
    ...Object.values(value.dependencies),
    ...Object.values(value.decisions).map((decision) => decision.evidence),
    value.decisions.privacy.dpia_evidence,
  ].filter(Boolean);
  const identities = references.map(evidenceIdentity);
  assert(new Set(identities).size === identities.length,
    'critical evidence references must be distinct');
  return value;
}

function decisionBlockers(value, key, nowMs) {
  const decision = value.decisions[key];
  const blockers = [];
  if (value.target_environment !== 'production') {
    blockers.push('target_environment_not_production');
  }
  if (!COMMIT_SHA.test(value.candidate_commit_sha || '')) {
    blockers.push('candidate_commit_not_recorded');
  }
  if (!DEPLOYMENT_ID.test(value.deployment_id || '')) {
    blockers.push('deployment_not_recorded');
  }
  if (!decision.approved) blockers.push(`${key}_not_approved`);
  if (!isStrongSha256(decision.reviewer_reference_sha256)) {
    blockers.push(`${key}_reviewer_reference_missing`);
  }
  if (!isEvidenceReference(decision.evidence, nowMs)) {
    blockers.push(`${key}_evidence_missing`);
  }
  const decidedAt = parseTimestamp(decision.decided_at);
  if (decidedAt === null || decidedAt > nowMs) {
    blockers.push(`${key}_decision_time_invalid`);
  }
  const expiresAt = parseTimestamp(decision.valid_until);
  if (decision.valid_until !== null
    && (expiresAt === null || expiresAt <= nowMs || expiresAt <= decidedAt)) {
    blockers.push(`${key}_approval_expired_or_invalid`);
  }
  if (Object.values(decision.checks).some((passed) => passed !== true)) {
    blockers.push(`${key}_checks_incomplete`);
  }
  if (decidedAt !== null && decision.evidence) {
    const verifiedAt = parseTimestamp(decision.evidence.verified_at);
    if (verifiedAt === null || verifiedAt < decidedAt) {
      blockers.push(`${key}_evidence_predates_decision`);
    }
  }
  if (key === 'privacy') {
    const dpiaValidatedAt = parseTimestamp(
      decision.dpia_controller_validated_at,
    );
    if (decision.dpia_outcome === 'pending') {
      blockers.push('privacy_dpia_pending');
    } else if (decision.dpia_outcome === 'prior_consultation_required') {
      blockers.push('privacy_dpia_prior_consultation_required');
    }
    if (dpiaValidatedAt === null
      || dpiaValidatedAt > nowMs
      || (decidedAt !== null && dpiaValidatedAt > decidedAt)) {
      blockers.push('privacy_dpia_controller_validation_invalid');
    }
    if (!isEvidenceReference(decision.dpia_evidence, nowMs)) {
      blockers.push('privacy_dpia_evidence_missing');
    } else {
      const dpiaEvidenceAt = parseTimestamp(
        decision.dpia_evidence.verified_at,
      );
      if (dpiaValidatedAt !== null && dpiaEvidenceAt < dpiaValidatedAt) {
        blockers.push('privacy_dpia_evidence_predates_validation');
      }
    }
  }
  return blockers;
}

function approvalBlockers(value, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const legal = decisionBlockers(value, 'legal_and_tax', nowMs);
  const privacy = decisionBlockers(value, 'privacy', nowMs);
  const country = decisionBlockers(value, 'country_policy', nowMs);
  if (!value.program.version_key) {
    legal.push('program_version_not_recorded');
    country.push('program_version_not_recorded');
  }
  const publicSurfaces = value.documents.public_surfaces;
  const surfaceReferences = [
    publicSurfaces.deployment_evidence,
    publicSurfaces.terms_evidence,
    publicSurfaces.privacy_evidence,
    publicSurfaces.partners_terms_evidence,
  ];
  const publicSurfacesAt = parseTimestamp(publicSurfaces.verified_at);
  const surfaceEvidenceTimes = surfaceReferences
    .filter(Boolean)
    .map((reference) => parseTimestamp(reference.verified_at));
  const publicSurfacesReady = Number.isFinite(publicSurfacesAt)
    && surfaceReferences.every((reference) => (
      isEvidenceReference(reference, nowMs)
    ))
    && surfaceEvidenceTimes.every((verifiedAt) => (
      Number.isFinite(verifiedAt) && verifiedAt <= publicSurfacesAt
    ));
  if (!value.documents.partners_terms_version
    || !value.documents.partners_terms_sha256
    || !value.documents.disclosure_version
    || !value.documents.disclosure_sha256
    || !publicSurfacesReady) {
    legal.push('legal_documents_not_verified');
  }
  if (!value.documents.privacy_version
    || !value.documents.privacy_sha256
    || !publicSurfacesReady) {
    privacy.push('privacy_document_not_verified');
  }
  const legalDecisionAt = parseTimestamp(
    value.decisions.legal_and_tax.decided_at,
  );
  const privacyDecisionAt = parseTimestamp(value.decisions.privacy.decided_at);
  if (Number.isFinite(publicSurfacesAt)
    && (legalDecisionAt === null || legalDecisionAt <= publicSurfacesAt)) {
    legal.push('legal_and_tax_decision_predates_public_surfaces');
  }
  if (Number.isFinite(publicSurfacesAt)
    && (privacyDecisionAt === null || privacyDecisionAt <= publicSurfacesAt)) {
    privacy.push('privacy_decision_predates_public_surfaces');
  }
  if (!value.jurisdiction.policy_key
    || !value.jurisdiction.individual_available
    || !value.jurisdiction.effective_from) {
    country.push('country_policy_not_available_or_versioned');
  }
  const dependencyTimes = [];
  for (const [key, reference] of Object.entries(value.dependencies)) {
    if (!reference) {
      country.push(`${key}_missing`);
    } else {
      dependencyTimes.push(parseTimestamp(reference.verified_at));
    }
  }
  if (legal.length) country.push('legal_and_tax_dependency_incomplete');
  if (privacy.length) country.push('privacy_dependency_incomplete');
  const countryDecisionAt = parseTimestamp(
    value.decisions.country_policy.decided_at,
  );
  const legalEvidenceAt = value.decisions.legal_and_tax.evidence
    ? parseTimestamp(value.decisions.legal_and_tax.evidence.verified_at)
    : null;
  const privacyEvidenceAt = value.decisions.privacy.evidence
    ? parseTimestamp(value.decisions.privacy.evidence.verified_at)
    : null;
  const dpiaEvidenceAt = value.decisions.privacy.dpia_evidence
    ? parseTimestamp(value.decisions.privacy.dpia_evidence.verified_at)
    : null;
  const cutoff = Math.max(
    ...dependencyTimes.filter(Number.isFinite),
    ...[legalEvidenceAt, privacyEvidenceAt, dpiaEvidenceAt]
      .filter(Number.isFinite),
  );
  if (Number.isFinite(cutoff)
    && (countryDecisionAt === null || countryDecisionAt <= cutoff)) {
    country.push('country_policy_decision_predates_dependencies');
  }
  if (value.status === 'approved'
    && (legal.length || privacy.length || country.length)) {
    country.push('approved_package_has_blockers');
  }
  return {
    legal_and_tax: [...new Set(legal)].sort(),
    privacy: [...new Set(privacy)].sort(),
    country_policy: [...new Set(country)].sort(),
  };
}

function evaluateApprovalPackage(value, options = {}) {
  const validated = validateApprovalPackage(value, options);
  return {
    evidence: validated,
    blockers: approvalBlockers(validated, options),
  };
}

function parseCliArgs(args) {
  let file = null;
  let expectedCommitSha = null;
  const required = new Set();
  for (const arg of args) {
    if (arg === '--require-legal') required.add('legal_and_tax');
    else if (arg === '--require-privacy') required.add('privacy');
    else if (arg === '--require-country-policy') required.add('country_policy');
    else if (arg === '--require-all') {
      required.add('legal_and_tax');
      required.add('privacy');
      required.add('country_policy');
    } else if (arg.startsWith('--expected-commit-sha=')) {
      expectedCommitSha = arg.slice('--expected-commit-sha='.length);
      assert(COMMIT_SHA.test(expectedCommitSha),
        '--expected-commit-sha must be 40 lowercase hex characters');
    } else {
      assert(!arg.startsWith('-'), `unknown option: ${arg}`);
      assert(file === null, 'exactly one approval package is required');
      file = arg;
    }
  }
  assert(file !== null, 'exactly one approval package is required');
  assert(required.size === 0 || expectedCommitSha !== null,
    '--expected-commit-sha is required with an approval requirement');
  return { expectedCommitSha, file, required: [...required] };
}

if (require.main === module) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const file = path.resolve(process.cwd(), cli.file);
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cli.expectedCommitSha !== null) {
      assert(value.candidate_commit_sha === cli.expectedCommitSha,
        'candidate_commit_sha does not match --expected-commit-sha');
    }
    const result = evaluateApprovalPackage(value);
    const blocked = cli.required.filter(
      (key) => result.blockers[key].length > 0,
    );
    if (cli.required.length === 3) {
      if (value.status !== 'approved') blocked.push('package_status');
    }
    console.log(JSON.stringify({
      status: blocked.length ? 'blocked' : value.status,
      blockers: result.blockers,
    }, null, 2));
    if (blocked.length) process.exit(1);
  } catch (error) {
    console.error(`Invalid Partners approval evidence: ${error.message}`);
    console.error(
      'Usage: node scripts/validate-partners-approval-evidence.js '
        + '<approval-package.json> '
        + '[--require-legal] [--require-privacy] '
        + '[--require-country-policy|--require-all] '
        + '[--expected-commit-sha=<40-lowercase-hex>]',
    );
    process.exit(1);
  }
}

module.exports = {
  COUNTRY_CHECKS,
  LEGAL_CHECKS,
  PRIVACY_CHECKS,
  approvalBlockers,
  evaluateApprovalPackage,
  parseCliArgs,
  validateApprovalPackage,
};
