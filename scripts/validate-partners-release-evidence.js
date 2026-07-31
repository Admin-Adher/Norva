'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const READY_PROVIDER_STATUS = 'configured_and_verified';
const PAYOUT_CYCLE_COMPLETE = 'supervised_and_reconciled';
const PILOT_PAYOUT_PROVIDER = 'revolut';
const PILOT_PAYOUT_EXECUTION_ADAPTER = 'revolut_manual';
const PILOT_PAYOUT_RECONCILIATION_CONTRACT =
  'revolut-manual-statement-v2';
const PILOT_PAYOUT_REFERENCE_CONTRACT = 'norva-payout-reference-v1';
const PILOT_PAYOUT_BENEFICIARY_BINDING_CONTRACT =
  'revolut-beneficiary-binding-v1';
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const VERSION_KEY = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const DEPLOYMENT_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const EVIDENCE_RUN_ID =
  /^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/-]{7,127}$/;
const EVIDENCE_REFERENCE_KEYS = [
  'run_id',
  'sha256',
  'url',
  'verified_at',
];
const PLACEHOLDER_EVIDENCE =
  /(?:replace[-_.]?me|placeholder|example|sample|dummy|todo|tbd|proof[-_.]?here|run[-_.:]?123(?:\D|$)|sandbox[-_.]?run[-_.]?verified)/i;
const PLAY_PHONE_PACKAGE = 'tv.norva.phone';
const PLAY_REFERRAL_PATH = '/r/{code}';
const PUBLIC_SURFACE_HASH_BASIS = 'normalized_deployment_artifact';
const REPOSITORY = 'Admin-Adher/Norva';
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const IPV4 =
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const FORBIDDEN_KEYS = new Set([
  'name',
  'display_name',
  'legal_name',
  'email',
  'email_address',
  'e_mail',
  'full_name',
  'first_name',
  'last_name',
  'given_name',
  'family_name',
  'middle_name',
  'phone',
  'phone_number',
  'telephone',
  'mobile_number',
  'dob',
  'date_of_birth',
  'birth_date',
  'birthday',
  'iban',
  'bic',
  'swift',
  'bank_account',
  'bank_account_number',
  'account_number',
  'routing_number',
  'card_number',
  'wallet_address',
  'beneficiary_id',
  'national_id',
  'tax_id',
  'ssn',
  'passport',
  'user_id',
  'customer_id',
  'account_id',
  'person_id',
  'profile_id',
  'payment_id',
  'transaction_id',
  'transfer_id',
  'order_id',
  'purchase_token',
  'session_id',
  'verification_session_id',
  'provider_id',
  'provider_session_id',
  'provider_payment_id',
  'provider_event_id',
  'provider_reference',
  'payout_id',
  'kyc_session_id',
  'provider_payload',
  'device_id',
  'advertising_id',
  'install_id',
  'cookie',
  'ip',
  'ip_address',
  'address',
  'street',
  'city',
  'postal_code',
  'zip_code',
  'latitude',
  'longitude',
  'location',
  'geo',
  'document',
  'document_id',
  'token',
  'secret',
  'referral_code',
]);
const ISO_COUNTRIES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI
  BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO
  CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO
  FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT
  HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY
  KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP
  MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE
  PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH
  SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO
  TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`
    .split(/\s+/),
);
const ISO_CURRENCIES = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND
  BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC
  CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD
  GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR
  KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP
  MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP
  PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP
  STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU
  UYW UZS VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XDR XOF XPD XPF
  XPT XSU XTS XUA XXX YER ZAR ZMW ZWG`
    .split(/\s+/),
);
const NON_PAYOUT_CURRENCIES = new Set([
  'BOV',
  'CHE',
  'CHW',
  'CLF',
  'COU',
  'MXV',
  'USN',
  'UYI',
  'UYW',
  'XAG',
  'XAU',
  'XBA',
  'XBB',
  'XBC',
  'XBD',
  'XDR',
  'XPD',
  'XPT',
  'XSU',
  'XTS',
  'XUA',
  'XXX',
]);

const TOP_LEVEL_KEYS = [
  'schema_version',
  'status',
  'release_key',
  'candidate_commit_sha',
  'repository',
  'target_environment',
  'deployment_id',
  'contains_personal_data',
  'program',
  'legal',
  'jurisdictions',
  'allowlist',
  'database_snapshot',
  'app_links',
  'providers',
  'feature_flags',
  'release_gates',
  'payout_reconciliation',
  'quality',
  'runtime',
  'payout_cycles',
  'approvals',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, expectedKeys, trail) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${trail} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    actual.length === expected.length
      && actual.every((key, index) => key === expected[index]),
    `${trail} must contain exactly: ${expected.join(', ')}`,
  );
}

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function assertNoPersonalData(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPersonalData(item, `${trail}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(
        !FORBIDDEN_KEYS.has(normalizeKey(key)),
        `forbidden evidence key at ${trail}.${key}`,
      );
      assertNoPersonalData(child, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value === 'string') {
    assert(!EMAIL.test(value), `email-like value found at ${trail}`);
    assert(!UUID.test(value), `UUID-like value found at ${trail}`);
    assert(!IBAN.test(value), `IBAN-like value found at ${trail}`);
    if (IPV4.test(value)) {
      const candidates = value.match(new RegExp(IPV4.source, 'g')) || [];
      assert(
        candidates.every((candidate) => net.isIP(candidate) === 0),
        `IP-like value found at ${trail}`,
      );
    }
  }
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/,
  );
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day
    || calendar.getUTCHours() !== hour
    || calendar.getUTCMinutes() !== minute
    || calendar.getUTCSeconds() !== second
  ) {
    return null;
  }
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function isIsoTimestamp(value) {
  return parseIsoTimestamp(value) !== null;
}

function isStrongSha256(value) {
  return SHA256.test(value || '')
    && !/^([a-f0-9])\1{63}$/.test(value)
    && new Set(value).size >= 4;
}

function isSafeOpaqueIdentifier(value, pattern) {
  return typeof value === 'string'
    && pattern.test(value)
    && !PLACEHOLDER_EVIDENCE.test(value)
    && !value.includes('..')
    && !value.includes('//')
    && !value.includes('\\')
    && !value.split('/').some((segment) => segment === '.' || segment === '..');
}

function isEvidenceRunId(value) {
  return isSafeOpaqueIdentifier(value, EVIDENCE_RUN_ID);
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (
      b === 0
      || b === 168
    ))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:')
    || normalized.startsWith('::ffff:')
  ) {
    return true;
  }
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isEvidenceUrl(value) {
  if (
    typeof value !== 'string'
    || value.length > 2_048
    || PLACEHOLDER_EVIDENCE.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    const ipVersion = net.isIP(hostname);
    const reservedHostname = hostname === 'localhost'
      || hostname === 'metadata'
      || hostname === 'metadata.google.internal'
      || hostname === 'instance-data'
      || hostname === 'instance-data.ec2.internal'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.invalid')
      || hostname.endsWith('.internal')
      || hostname.endsWith('.local')
      || hostname.endsWith('.home')
      || hostname.endsWith('.lan')
      || hostname === 'example.com'
      || hostname.endsWith('.example.com');
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && !reservedHostname
      && (ipVersion !== 4 || !isPrivateIpv4(hostname))
      && (ipVersion !== 6 || !isPrivateIpv6(hostname));
  } catch {
    return false;
  }
}

function isEvidenceReference(value, nowMs = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EVIDENCE_REFERENCE_KEYS.length
    || keys.some((key, index) => key !== EVIDENCE_REFERENCE_KEYS[index])
  ) {
    return false;
  }
  const verifiedAt = parseIsoTimestamp(value.verified_at);
  return isEvidenceUrl(value.url)
    && isEvidenceRunId(value.run_id)
    && isStrongSha256(value.sha256)
    && verifiedAt !== null
    && verifiedAt <= nowMs + MAX_EVIDENCE_CLOCK_SKEW_MS;
}

function assertOptionalEvidenceReference(value, trail, nowMs) {
  assert(
    value === null || isEvidenceReference(value, nowMs),
    `${trail} must be null or a strict immutable evidence reference`,
  );
}

function referenceIdentity(reference) {
  return [
    reference.url,
    reference.run_id,
    reference.sha256,
    reference.verified_at,
  ].join('|');
}

function collectEvidenceReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const child of value) collectEvidenceReferences(child, references);
    return references;
  }
  if (!value || typeof value !== 'object') return references;
  const keys = Object.keys(value).sort();
  if (
    keys.length === EVIDENCE_REFERENCE_KEYS.length
    && keys.every((key, index) => key === EVIDENCE_REFERENCE_KEYS[index])
  ) {
    references.push(value);
    return references;
  }
  for (const child of Object.values(value)) {
    collectEvidenceReferences(child, references);
  }
  return references;
}

function assertDistinctReferenceFields(references, trail) {
  const present = references.filter(Boolean);
  for (const field of ['url', 'run_id', 'sha256']) {
    assert(
      new Set(present.map((reference) => reference[field])).size
        === present.length,
      `${trail} must use distinct ${field} values`,
    );
  }
}

function maxTimestamp(values) {
  const timestamps = values
    .map((value) => {
      if (value && typeof value === 'object') {
        return parseIsoTimestamp(value.verified_at);
      }
      return parseIsoTimestamp(value);
    })
    .filter((value) => value !== null);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function pilotAuthorityCutoff(evidence) {
  const publicSurfaces = evidence.legal.public_surfaces;
  const providerEvidence = Object.values(evidence.providers)
    .flatMap((provider) => [
      provider.sandbox_evidence,
      provider.production_evidence,
      provider.live_evidence,
      provider.environment_isolation_evidence,
    ]);
  return maxTimestamp([
    evidence.legal.privacy_review_evidence,
    publicSurfaces.verified_at,
    publicSurfaces.deployment_evidence,
    publicSurfaces.terms_evidence,
    publicSurfaces.privacy_evidence,
    publicSurfaces.partners_terms_evidence,
    evidence.database_snapshot.evidence,
    evidence.app_links.android_phone.evidence,
    ...providerEvidence,
    evidence.payout_reconciliation
      .statement_completeness_evidence,
    evidence.payout_reconciliation
      .beneficiary_registry_evidence,
    evidence.payout_reconciliation
      .incident_resolution_evidence,
    evidence.payout_reconciliation
      .legacy_provider_crons_evidence,
    evidence.quality.partners_ci_run_evidence,
    evidence.quality.offsite_backup_evidence,
    evidence.quality.restore_drill_evidence,
    evidence.runtime.worker_cron_evidence,
    evidence.runtime.shadow_observation.completed_at,
    evidence.runtime.shadow_observation.evidence,
    evidence.runtime.alert_and_recovery_evidence,
  ]);
}

function generalReleaseCutoff(evidence) {
  return maxTimestamp([
    evidence.runtime.pilot_observation.completed_at,
    evidence.runtime.pilot_observation.evidence,
    ...evidence.payout_cycles.flatMap((cycle) => [
      cycle.period_completed_at,
      cycle.reconciliation_evidence,
    ]),
    ...Object.values(evidence.approvals)
      .map((approval) => approval.evidence),
  ]);
}

function isOrderedObservation(value, minimumDays = 0, nowMs = Date.now()) {
  if (!value || typeof value !== 'object') return false;
  const startedAt = parseIsoTimestamp(value.started_at);
  const completedAt = parseIsoTimestamp(value.completed_at);
  const verifiedAt = parseIsoTimestamp(value.evidence?.verified_at);
  if (
    startedAt === null
    || completedAt === null
    || completedAt > nowMs
    || !isEvidenceReference(value.evidence, nowMs)
    || verifiedAt < completedAt
  ) {
    return false;
  }
  const elapsed = completedAt - startedAt;
  if (elapsed < minimumDays * DAY_MS) return false;
  return !Object.hasOwn(value, 'observed_days')
    || value.observed_days === Math.floor(elapsed / DAY_MS);
}

function validateObservation(value, kind, nowMs) {
  const keys = kind === 'pilot'
    ? ['started_at', 'completed_at', 'observed_days', 'evidence']
    : ['started_at', 'completed_at', 'clean', 'evidence'];
  assertExactKeys(value, keys, `runtime.${kind}_observation`);
  const startedAt = value.started_at === null
    ? null
    : parseIsoTimestamp(value.started_at);
  const completedAt = value.completed_at === null
    ? null
    : parseIsoTimestamp(value.completed_at);
  assert(
    startedAt !== null || value.started_at === null,
    `runtime ${kind} observation started_at must be null or valid ISO UTC`,
  );
  assert(
    completedAt !== null || value.completed_at === null,
    `runtime ${kind} observation completed_at must be null or valid ISO UTC`,
  );
  assert(
    (startedAt === null) === (completedAt === null),
    `runtime ${kind} observation timestamps must be paired`,
  );
  if (startedAt !== null) {
    assert(
      startedAt <= completedAt && completedAt <= nowMs,
      `runtime ${kind} observation must satisfy start <= complete <= now`,
    );
  }
  assertOptionalEvidenceReference(
    value.evidence,
    `runtime.${kind}_observation.evidence`,
    nowMs,
  );
  if (value.evidence && completedAt !== null) {
    assert(
      parseIsoTimestamp(value.evidence.verified_at) >= completedAt,
      `runtime ${kind} evidence must be verified after completion`,
    );
  }
  if (kind === 'pilot') {
    assert(
      Number.isSafeInteger(value.observed_days) && value.observed_days >= 0,
      'runtime pilot observation observed_days must be non-negative',
    );
    const expectedDays = startedAt === null
      ? 0
      : Math.floor((completedAt - startedAt) / DAY_MS);
    assert(
      value.observed_days === expectedDays,
      'runtime pilot observed_days must exactly match elapsed UTC days',
    );
  } else {
    assert(
      typeof value.clean === 'boolean',
      'runtime shadow observation clean must be boolean',
    );
  }
}

function validateEvidence(evidence, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  assert(evidence && typeof evidence === 'object', 'evidence must be an object');
  assertNoPersonalData(evidence);
  assertExactKeys(evidence, TOP_LEVEL_KEYS, 'evidence');
  assert(evidence.schema_version === 5, 'schema_version must equal 5');
  assert(
    ['draft', 'pilot_ready', 'generalization_ready'].includes(evidence.status),
    'status must be draft, pilot_ready or generalization_ready',
  );
  assert(
    typeof evidence.release_key === 'string'
      && VERSION_KEY.test(evidence.release_key),
    'release_key must be a version key, never a user identifier',
  );
  assert(
    evidence.candidate_commit_sha === null
      || COMMIT_SHA.test(evidence.candidate_commit_sha),
    'candidate_commit_sha must be null or a 40-character lowercase Git SHA',
  );
  assert(
    evidence.repository === REPOSITORY,
    `repository must equal ${REPOSITORY}`,
  );
  assert(
    ['sandbox', 'production'].includes(evidence.target_environment),
    'target_environment must be sandbox or production',
  );
  assert(
    evidence.deployment_id === null
      || isSafeOpaqueIdentifier(evidence.deployment_id, DEPLOYMENT_ID),
    'deployment_id must be null or a non-placeholder immutable identifier',
  );
  assert(
    evidence.contains_personal_data === false,
    'release evidence must declare contains_personal_data=false',
  );

  assertExactKeys(evidence.program, [
    'version_key',
    'commission_rate_bps',
    'attribution_window_days',
    'maturation_days',
  ], 'program');
  assert(
    evidence.program.commission_rate_bps === 2000,
    'commission_rate_bps must equal 2000',
  );
  assert(
    evidence.program.attribution_window_days === 30,
    'attribution_window_days must equal 30',
  );
  assert(
    evidence.program.maturation_days === 45,
    'maturation_days must equal 45',
  );
  assert(
    evidence.program.version_key === null
      || VERSION_KEY.test(evidence.program.version_key),
    'program version_key must be null or versioned',
  );

  assertExactKeys(evidence.legal, [
    'terms_version',
    'terms_sha256',
    'disclosure_version',
    'disclosure_sha256',
    'privacy_review_evidence',
    'public_surfaces',
  ], 'legal');
  for (const key of ['terms_sha256', 'disclosure_sha256']) {
    assert(
      evidence.legal[key] === null || isStrongSha256(evidence.legal[key]),
      `legal ${key} must be null or a non-placeholder SHA-256`,
    );
  }
  assertOptionalEvidenceReference(
    evidence.legal.privacy_review_evidence,
    'legal.privacy_review_evidence',
    nowMs,
  );
  const publicSurfaces = evidence.legal.public_surfaces;
  assertExactKeys(publicSurfaces, [
    'verified_at',
    'hash_basis',
    'deployment_evidence',
    'terms_evidence',
    'privacy_evidence',
    'partners_terms_evidence',
  ], 'legal.public_surfaces');
  assert(
    publicSurfaces.hash_basis === PUBLIC_SURFACE_HASH_BASIS,
    `legal public surface hash_basis must equal ${PUBLIC_SURFACE_HASH_BASIS}`,
  );
  for (const key of [
    'deployment_evidence',
    'terms_evidence',
    'privacy_evidence',
    'partners_terms_evidence',
  ]) {
    assertOptionalEvidenceReference(
      publicSurfaces[key],
      `legal.public_surfaces.${key}`,
      nowMs,
    );
  }
  const publicVerifiedAt = publicSurfaces.verified_at === null
    ? null
    : parseIsoTimestamp(publicSurfaces.verified_at);
  assert(
    publicVerifiedAt !== null || publicSurfaces.verified_at === null,
    'legal public surface verified_at must be null or a valid ISO UTC timestamp',
  );
  assert(
    publicVerifiedAt === null || publicVerifiedAt <= nowMs,
    'legal public surface verified_at cannot be in the future',
  );

  assert(Array.isArray(evidence.jurisdictions),
    'jurisdictions must be an array');
  evidence.jurisdictions.forEach((jurisdiction, index) => {
    const trail = `jurisdictions[${index}]`;
    assertExactKeys(jurisdiction, [
      'country_code',
      'subdivision_code',
      'policy_key',
      'payout_currencies',
      'gates',
    ], trail);
    assert(
      ISO_COUNTRIES.has(jurisdiction.country_code),
      'jurisdiction country_code must be an assigned ISO 3166-1 alpha-2 code',
    );
    assert(
      jurisdiction.subdivision_code === null
        || typeof jurisdiction.subdivision_code === 'string',
      'subdivision_code must be null or a string',
    );
    assert(
      VERSION_KEY.test(jurisdiction.policy_key || ''),
      'jurisdiction policy_key must be versioned',
    );
    assert(
      Array.isArray(jurisdiction.payout_currencies)
        && jurisdiction.payout_currencies.length > 0
        && jurisdiction.payout_currencies.every((code) =>
          ISO_CURRENCIES.has(code) && !NON_PAYOUT_CURRENCIES.has(code)),
      'each jurisdiction needs at least one assigned ISO 4217 tender payout currency',
    );
    assertExactKeys(jurisdiction.gates, [
      'legal_contract_and_disclosure',
      'didit_identity_age_country_capacity',
      'individual_tax',
      'individual_payout',
      'exact_financial_data',
    ], `${trail}.gates`);
    for (const [gate, value] of Object.entries(jurisdiction.gates)) {
      assert(typeof value === 'boolean',
        `jurisdiction gate ${gate} must be boolean`);
    }
  });

  assertExactKeys(evidence.allowlist, [
    'target_min',
    'target_max',
    'configured_count',
    'identities_stored_in_evidence',
  ], 'allowlist');
  assert(evidence.allowlist.target_min === 20,
    'allowlist target_min must equal 20');
  assert(evidence.allowlist.target_max === 50,
    'allowlist target_max must equal 50');
  assert(
    Number.isSafeInteger(evidence.allowlist.configured_count)
      && evidence.allowlist.configured_count >= 0,
    'allowlist configured_count must be a non-negative integer',
  );
  assert(
    evidence.allowlist.identities_stored_in_evidence === false,
    'allowlist identities must not be stored in release evidence',
  );

  assertExactKeys(evidence.database_snapshot, [
    'status',
    'evidence',
    'includes',
  ], 'database_snapshot');
  assert(
    ['not_captured', 'captured_and_reviewed']
      .includes(evidence.database_snapshot.status),
    'database snapshot status is invalid',
  );
  assertOptionalEvidenceReference(
    evidence.database_snapshot.evidence,
    'database_snapshot.evidence',
    nowMs,
  );
  assertExactKeys(evidence.database_snapshot.includes, [
    'program_versions',
    'country_policies',
    'currency_metadata',
    'payout_provider_routes',
    'pilot_allowlist',
    'feature_flags',
    'release_gates',
  ], 'database_snapshot.includes');
  for (const [key, value] of Object.entries(evidence.database_snapshot.includes)) {
    assert(typeof value === 'boolean',
      `database snapshot includes.${key} must be boolean`);
  }

  assertExactKeys(evidence.app_links, ['android_phone'], 'app_links');
  const appLink = evidence.app_links.android_phone;
  assertExactKeys(appLink, [
    'status',
    'package_name',
    'referral_path',
    'play_signed_aab',
    'evidence',
  ], 'app_links.android_phone');
  assert(
    ['not_verified', 'play_signed_aab_verified'].includes(appLink.status),
    'Android App Link status is invalid',
  );
  assert(appLink.package_name === PLAY_PHONE_PACKAGE,
    `Android App Link package must equal ${PLAY_PHONE_PACKAGE}`);
  assert(appLink.referral_path === PLAY_REFERRAL_PATH,
    `Android App Link referral path must equal ${PLAY_REFERRAL_PATH}`);
  assert(typeof appLink.play_signed_aab === 'boolean',
    'Android App Link play_signed_aab must be boolean');
  assertOptionalEvidenceReference(
    appLink.evidence,
    'app_links.android_phone.evidence',
    nowMs,
  );

  const providerNames = [
    'didit',
    'individual_payout',
    'web_tax',
    'google_play_orders',
    'revenuecat',
    'revolut',
  ];
  assertExactKeys(evidence.providers, providerNames, 'providers');
  for (const providerName of providerNames) {
    const provider = evidence.providers[providerName];
    const keys = providerName === 'didit'
      ? [
        'status',
        'environment',
        'config_fingerprint_sha256',
        'workflow_version',
        'sandbox_evidence',
        'live_evidence',
        'environment_isolation_evidence',
      ]
      : providerName === 'individual_payout'
        ? [
          'status',
          'provider',
          'execution_adapter',
          'production_evidence',
        ]
        : ['status', 'sandbox_evidence'];
    assertExactKeys(provider, keys, `providers.${providerName}`);
    assert(
      ['not_configured', 'not_selected', READY_PROVIDER_STATUS]
        .includes(provider.status),
      `provider ${providerName} status is invalid`,
    );
    if (providerName === 'individual_payout') {
      assertOptionalEvidenceReference(
        provider.production_evidence,
        `providers.${providerName}.production_evidence`,
        nowMs,
      );
    } else {
      assertOptionalEvidenceReference(
        provider.sandbox_evidence,
        `providers.${providerName}.sandbox_evidence`,
        nowMs,
      );
    }
  }
  const didit = evidence.providers.didit;
  assert(
    ['sandbox', 'live'].includes(didit.environment),
    'provider didit environment must be sandbox or live',
  );
  assertOptionalEvidenceReference(
    didit.live_evidence,
    'providers.didit.live_evidence',
    nowMs,
  );
  assert(
    didit.config_fingerprint_sha256 === null
      || isStrongSha256(didit.config_fingerprint_sha256),
    'provider didit config_fingerprint_sha256 must be null or a strong SHA-256',
  );
  assert(
    didit.workflow_version === null
      || (
        Number.isSafeInteger(didit.workflow_version)
        && didit.workflow_version >= 1
        && didit.workflow_version <= 1_000_000
      ),
    'provider didit workflow_version must be null or a positive bounded integer',
  );
  assertOptionalEvidenceReference(
    didit.environment_isolation_evidence,
    'providers.didit.environment_isolation_evidence',
    nowMs,
  );
  assertDistinctReferenceFields(
    [
      didit.sandbox_evidence,
      didit.live_evidence,
      didit.environment_isolation_evidence,
    ],
    'Didit sandbox, live and environment-isolation evidence',
  );
  const individualPayout = evidence.providers.individual_payout;
  assert(
    individualPayout.provider === null
      || individualPayout.provider === PILOT_PAYOUT_PROVIDER,
    `individual payout provider must be null or ${PILOT_PAYOUT_PROVIDER}`,
  );
  assert(
    individualPayout.execution_adapter === null
      || individualPayout.execution_adapter
        === PILOT_PAYOUT_EXECUTION_ADAPTER,
    'individual payout execution_adapter must be null or revolut_manual',
  );
  assert(
    (individualPayout.provider === null)
      === (individualPayout.execution_adapter === null),
    'individual payout provider and execution_adapter must be selected together',
  );
  assert(
    individualPayout.status !== READY_PROVIDER_STATUS
      || (
        individualPayout.provider === PILOT_PAYOUT_PROVIDER
        && individualPayout.execution_adapter
          === PILOT_PAYOUT_EXECUTION_ADAPTER
      ),
    'verified individual payout must use revolut with revolut_manual',
  );

  assertExactKeys(evidence.feature_flags, [
    'partners_enabled',
    'partners_invite_only',
    'partners_shadow_mode',
    'partners_payouts_live',
    'partners_tv_relay_enabled',
    'partners_revolut_api_enabled',
  ], 'feature_flags');
  for (const [key, value] of Object.entries(evidence.feature_flags)) {
    assert(typeof value === 'boolean', `feature flag ${key} must be boolean`);
  }

  assertExactKeys(evidence.release_gates, [
    'general_release_approved',
    'general_release_evidence',
  ], 'release_gates');
  assert(
    typeof evidence.release_gates.general_release_approved === 'boolean',
    'general release gate must be boolean',
  );
  assertOptionalEvidenceReference(
    evidence.release_gates.general_release_evidence,
    'release_gates.general_release_evidence',
    nowMs,
  );

  assertExactKeys(evidence.payout_reconciliation, [
    'provider',
    'execution_adapter',
    'manual_route_status',
    'revolut_api_adapter_verified',
    'revolut_api_edge_enabled',
    'contract_version',
    'reference_contract',
    'beneficiary_binding_contract',
    'beneficiary_registry_status',
    'beneficiary_hmac_key_version',
    'beneficiary_registry_evidence',
    'statement_status',
    'statement_completeness_evidence',
    'incident_resolution_status',
    'incident_resolution_evidence',
    'legacy_provider_crons_status',
    'legacy_provider_crons_evidence',
  ], 'payout_reconciliation');
  assert(
    evidence.payout_reconciliation.provider === null
      || evidence.payout_reconciliation.provider === PILOT_PAYOUT_PROVIDER,
    `payout reconciliation provider must be null or ${PILOT_PAYOUT_PROVIDER}`,
  );
  assert(
    evidence.payout_reconciliation.execution_adapter === null
      || evidence.payout_reconciliation.execution_adapter
        === PILOT_PAYOUT_EXECUTION_ADAPTER,
    'payout reconciliation execution_adapter must be null or revolut_manual',
  );
  assert(
    ['not_verified', 'active'].includes(
      evidence.payout_reconciliation.manual_route_status,
    ),
    'manual payout route status is invalid',
  );
  assert(
    typeof evidence.payout_reconciliation.revolut_api_adapter_verified
      === 'boolean',
    'Revolut API adapter gate evidence must be boolean',
  );
  assert(
    typeof evidence.payout_reconciliation.revolut_api_edge_enabled
      === 'boolean',
    'Revolut API Edge kill switch evidence must be boolean',
  );
  assert(
    evidence.payout_reconciliation.contract_version === null
      || evidence.payout_reconciliation.contract_version
        === PILOT_PAYOUT_RECONCILIATION_CONTRACT,
    'payout reconciliation contract version is invalid',
  );
  assert(
    evidence.payout_reconciliation.reference_contract === null
      || evidence.payout_reconciliation.reference_contract
        === PILOT_PAYOUT_REFERENCE_CONTRACT,
    'payout reconciliation reference contract is invalid',
  );
  assert(
    evidence.payout_reconciliation.beneficiary_binding_contract === null
      || evidence.payout_reconciliation.beneficiary_binding_contract
        === PILOT_PAYOUT_BENEFICIARY_BINDING_CONTRACT,
    'payout beneficiary binding contract is invalid',
  );
  assert(
    ['not_verified', 'maker_checker_verified'].includes(
      evidence.payout_reconciliation.beneficiary_registry_status,
    ),
    'payout beneficiary registry status is invalid',
  );
  assert(
    evidence.payout_reconciliation.beneficiary_hmac_key_version === null
      || (
        Number.isSafeInteger(
          evidence.payout_reconciliation.beneficiary_hmac_key_version,
        )
        && evidence.payout_reconciliation.beneficiary_hmac_key_version >= 1
        && evidence.payout_reconciliation.beneficiary_hmac_key_version
          <= 2147483646
      ),
    'payout beneficiary HMAC key version is invalid',
  );
  assertOptionalEvidenceReference(
    evidence.payout_reconciliation.beneficiary_registry_evidence,
    'payout_reconciliation.beneficiary_registry_evidence',
    nowMs,
  );
  assert(
    evidence.payout_reconciliation.beneficiary_registry_status
      !== 'maker_checker_verified'
      || (
        evidence.payout_reconciliation.beneficiary_binding_contract
          === PILOT_PAYOUT_BENEFICIARY_BINDING_CONTRACT
        && Number.isSafeInteger(
          evidence.payout_reconciliation.beneficiary_hmac_key_version,
        )
        && evidence.payout_reconciliation
          .beneficiary_registry_evidence !== null
      ),
    'verified beneficiary registry requires its contract, HMAC version and evidence',
  );
  assert(
    ['not_verified', 'imported_and_reconciled'].includes(
      evidence.payout_reconciliation.statement_status,
    ),
    'Revolut statement status is invalid',
  );
  assertOptionalEvidenceReference(
    evidence.payout_reconciliation.statement_completeness_evidence,
    'payout_reconciliation.statement_completeness_evidence',
    nowMs,
  );
  assert(
    evidence.payout_reconciliation.statement_status
      !== 'imported_and_reconciled'
      || (
        evidence.payout_reconciliation.provider === PILOT_PAYOUT_PROVIDER
        && evidence.payout_reconciliation.execution_adapter
          === PILOT_PAYOUT_EXECUTION_ADAPTER
        && evidence.payout_reconciliation.contract_version
          === PILOT_PAYOUT_RECONCILIATION_CONTRACT
        && evidence.payout_reconciliation.reference_contract
          === PILOT_PAYOUT_REFERENCE_CONTRACT
        && evidence.payout_reconciliation
          .statement_completeness_evidence !== null
      ),
    'reconciled statement must use the Revolut manual and Norva reference contracts',
  );
  assert(
    ['not_verified', 'maker_checker_verified'].includes(
      evidence.payout_reconciliation.incident_resolution_status,
    ),
    'Revolut incident resolution status is invalid',
  );
  assertOptionalEvidenceReference(
    evidence.payout_reconciliation.incident_resolution_evidence,
    'payout_reconciliation.incident_resolution_evidence',
    nowMs,
  );
  assert(
    evidence.payout_reconciliation.incident_resolution_status
      !== 'maker_checker_verified'
      || (
        evidence.payout_reconciliation.provider === PILOT_PAYOUT_PROVIDER
        && evidence.payout_reconciliation.execution_adapter
          === PILOT_PAYOUT_EXECUTION_ADAPTER
        && evidence.payout_reconciliation.contract_version
          === PILOT_PAYOUT_RECONCILIATION_CONTRACT
        && evidence.payout_reconciliation
          .incident_resolution_evidence !== null
      ),
    'verified Revolut incident resolution requires the manual v2 contract and evidence',
  );
  assert(
    ['not_verified', 'inactive'].includes(
      evidence.payout_reconciliation.legacy_provider_crons_status,
    ),
    'legacy payout cron status is invalid',
  );
  assertOptionalEvidenceReference(
    evidence.payout_reconciliation.legacy_provider_crons_evidence,
    'payout_reconciliation.legacy_provider_crons_evidence',
    nowMs,
  );
  assert(
    evidence.payout_reconciliation.legacy_provider_crons_status
      !== 'inactive'
      || evidence.payout_reconciliation
        .legacy_provider_crons_evidence !== null,
    'inactive legacy payout crons require evidence',
  );

  assertExactKeys(evidence.quality, [
    'partners_ci_run_evidence',
    'security_advisors_passed',
    'performance_advisors_passed',
    'offsite_backup_evidence',
    'offsite_backup_encrypted',
    'restore_drill_evidence',
    'restore_verifier_passed',
  ], 'quality');
  for (const key of [
    'partners_ci_run_evidence',
    'offsite_backup_evidence',
    'restore_drill_evidence',
  ]) {
    assertOptionalEvidenceReference(
      evidence.quality[key],
      `quality.${key}`,
      nowMs,
    );
  }
  for (const key of [
    'security_advisors_passed',
    'performance_advisors_passed',
    'offsite_backup_encrypted',
    'restore_verifier_passed',
  ]) {
    assert(typeof evidence.quality[key] === 'boolean',
      `quality.${key} must be boolean`);
  }

  assertExactKeys(evidence.runtime, [
    'worker_cron_evidence',
    'shadow_observation',
    'pilot_observation',
    'alert_and_recovery_evidence',
  ], 'runtime');
  assertOptionalEvidenceReference(
    evidence.runtime.worker_cron_evidence,
    'runtime.worker_cron_evidence',
    nowMs,
  );
  assertOptionalEvidenceReference(
    evidence.runtime.alert_and_recovery_evidence,
    'runtime.alert_and_recovery_evidence',
    nowMs,
  );
  validateObservation(evidence.runtime.shadow_observation, 'shadow', nowMs);
  validateObservation(evidence.runtime.pilot_observation, 'pilot', nowMs);

  assert(
    Array.isArray(evidence.payout_cycles)
      && evidence.payout_cycles.length === 2,
    'exactly two supervised payout cycles must be tracked',
  );
  assert(
    evidence.payout_cycles[0]?.sequence === 1
      && evidence.payout_cycles[1]?.sequence === 2,
    'payout cycle sequence must be 1 then 2',
  );
  evidence.payout_cycles.forEach((cycle, index) => {
    assertExactKeys(cycle, [
      'sequence',
      'status',
      'period_started_at',
      'period_completed_at',
      'reconciliation_evidence',
    ], `payout_cycles[${index}]`);
    assert(
      ['not_started', 'dry_run', 'submitted', PAYOUT_CYCLE_COMPLETE]
        .includes(cycle.status),
      `invalid payout cycle ${cycle.sequence} status`,
    );
    const startedAt = cycle.period_started_at === null
      ? null
      : parseIsoTimestamp(cycle.period_started_at);
    const completedAt = cycle.period_completed_at === null
      ? null
      : parseIsoTimestamp(cycle.period_completed_at);
    assert(
      startedAt !== null || cycle.period_started_at === null,
      `payout cycle ${cycle.sequence} start must be null or valid ISO UTC`,
    );
    assert(
      completedAt !== null || cycle.period_completed_at === null,
      `payout cycle ${cycle.sequence} completion must be null or valid ISO UTC`,
    );
    assert(
      (startedAt === null) === (completedAt === null),
      `payout cycle ${cycle.sequence} timestamps must be paired`,
    );
    if (startedAt !== null) {
      assert(
        startedAt <= completedAt && completedAt <= nowMs,
        `payout cycle ${cycle.sequence} must satisfy start <= complete <= now`,
      );
    }
    assertOptionalEvidenceReference(
      cycle.reconciliation_evidence,
      `payout_cycles[${index}].reconciliation_evidence`,
      nowMs,
    );
    if (cycle.reconciliation_evidence && completedAt !== null) {
      assert(
        parseIsoTimestamp(cycle.reconciliation_evidence.verified_at)
          >= completedAt,
        `payout cycle ${cycle.sequence} evidence predates completion`,
      );
    }
  });
  assertDistinctReferenceFields(
    evidence.payout_cycles.map((cycle) => cycle.reconciliation_evidence),
    'payout cycle evidence',
  );

  const approverNames = ['legal', 'risk', 'finance', 'operations'];
  assertExactKeys(evidence.approvals, approverNames, 'approvals');
  for (const approver of approverNames) {
    assertExactKeys(
      evidence.approvals[approver],
      ['approved', 'evidence'],
      `approvals.${approver}`,
    );
    assert(
      typeof evidence.approvals[approver].approved === 'boolean',
      `approval ${approver} approved must be boolean`,
    );
    assertOptionalEvidenceReference(
      evidence.approvals[approver].evidence,
      `approvals.${approver}.evidence`,
      nowMs,
    );
  }
  assertDistinctReferenceFields(
    approverNames.map((name) => evidence.approvals[name].evidence),
    'approval evidence',
  );

  const references = collectEvidenceReferences(evidence);
  const identities = references.map(referenceIdentity);
  assert(
    new Set(identities).size === identities.length,
    'critical evidence references must not be reused across gates',
  );
  return evidence;
}

function pilotReadinessBlockers(evidence, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const blockers = [];
  const require = (condition, code) => {
    if (!condition) blockers.push(code);
  };

  require(COMMIT_SHA.test(evidence.candidate_commit_sha || ''),
    'candidate_commit_not_recorded');
  require(isSafeOpaqueIdentifier(evidence.deployment_id, DEPLOYMENT_ID),
    'deployment_not_recorded');
  require(evidence.target_environment === 'production',
    'target_environment_not_production');
  require(VERSION_KEY.test(evidence.program.version_key || ''),
    'program_version_not_configured');
  require(
    VERSION_KEY.test(evidence.legal.terms_version || '')
      && isStrongSha256(evidence.legal.terms_sha256),
    'partner_terms_not_versioned_or_hashed',
  );
  require(
    VERSION_KEY.test(evidence.legal.disclosure_version || '')
      && isStrongSha256(evidence.legal.disclosure_sha256),
    'partner_disclosure_not_versioned_or_hashed',
  );
  require(isEvidenceReference(evidence.legal.privacy_review_evidence, nowMs),
    'privacy_review_evidence_missing');
  const publicSurfaces = evidence.legal.public_surfaces;
  require(
    isIsoTimestamp(publicSurfaces.verified_at)
      && parseIsoTimestamp(publicSurfaces.verified_at) <= nowMs
      && publicSurfaces.hash_basis === PUBLIC_SURFACE_HASH_BASIS
      && isEvidenceReference(publicSurfaces.deployment_evidence, nowMs)
      && isEvidenceReference(publicSurfaces.terms_evidence, nowMs)
      && isEvidenceReference(publicSurfaces.privacy_evidence, nowMs)
      && isEvidenceReference(publicSurfaces.partners_terms_evidence, nowMs),
    'legal_public_surfaces_not_verified',
  );
  require(evidence.jurisdictions.length > 0, 'no_jurisdiction_configured');
  for (const jurisdiction of evidence.jurisdictions) {
    require(
      Object.values(jurisdiction.gates).every(Boolean),
      `jurisdiction_${jurisdiction.country_code}_gates_incomplete`,
    );
  }
  require(
    evidence.allowlist.configured_count >= evidence.allowlist.target_min
      && evidence.allowlist.configured_count <= evidence.allowlist.target_max,
    'pilot_allowlist_outside_20_50',
  );
  require(
    evidence.database_snapshot.status === 'captured_and_reviewed'
      && isEvidenceReference(evidence.database_snapshot.evidence, nowMs)
      && Object.values(evidence.database_snapshot.includes).every(Boolean),
    'database_configuration_snapshot_not_verified',
  );
  require(
    evidence.app_links.android_phone.status === 'play_signed_aab_verified'
      && evidence.app_links.android_phone.play_signed_aab === true
      && isEvidenceReference(evidence.app_links.android_phone.evidence, nowMs),
    'play_signed_app_link_not_verified',
  );

  const didit = evidence.providers.didit;
  require(
    didit.status === READY_PROVIDER_STATUS
      && didit.environment === 'live'
      && isStrongSha256(didit.config_fingerprint_sha256)
      && Number.isSafeInteger(didit.workflow_version)
      && didit.workflow_version >= 1
      && isEvidenceReference(didit.sandbox_evidence, nowMs)
      && isEvidenceReference(didit.live_evidence, nowMs)
      && isEvidenceReference(didit.environment_isolation_evidence, nowMs)
      && referenceIdentity(didit.sandbox_evidence)
        !== referenceIdentity(didit.live_evidence),
    'provider_didit_not_verified',
  );
  for (const provider of [
    'web_tax',
    'google_play_orders',
    'revenuecat',
    'revolut',
  ]) {
    require(
      evidence.providers[provider].status === READY_PROVIDER_STATUS
        && isEvidenceReference(
          evidence.providers[provider].sandbox_evidence,
          nowMs,
        ),
      `provider_${provider}_not_verified`,
    );
  }
  require(
    evidence.providers.individual_payout.status === READY_PROVIDER_STATUS
      && evidence.providers.individual_payout.provider
        === PILOT_PAYOUT_PROVIDER
      && evidence.providers.individual_payout.execution_adapter
        === PILOT_PAYOUT_EXECUTION_ADAPTER
      && isEvidenceReference(
        evidence.providers.individual_payout.production_evidence,
        nowMs,
      ),
    'provider_individual_payout_not_verified',
  );

  require(evidence.feature_flags.partners_enabled === true,
    'partners_enabled_not_enabled');
  require(evidence.feature_flags.partners_invite_only === true,
    'partners_invite_only_not_enabled');
  require(evidence.feature_flags.partners_shadow_mode === true,
    'partners_shadow_mode_not_enabled');
  require(evidence.feature_flags.partners_payouts_live === false,
    'partners_payouts_live_must_remain_false');
  require(evidence.feature_flags.partners_tv_relay_enabled === true,
    'partners_tv_relay_not_enabled');
  require(evidence.feature_flags.partners_revolut_api_enabled === false,
    'partners_revolut_api_must_remain_false');
  require(
    evidence.payout_reconciliation.manual_route_status === 'active',
    'revolut_manual_route_not_verified',
  );
  require(
    evidence.payout_reconciliation.revolut_api_adapter_verified === false,
    'revolut_api_adapter_gate_must_remain_false',
  );
  require(
    evidence.payout_reconciliation.revolut_api_edge_enabled === false,
    'revolut_api_edge_kill_switch_must_remain_false',
  );
  require(
    evidence.payout_reconciliation.statement_status
      === 'imported_and_reconciled'
      && evidence.payout_reconciliation.provider
        === PILOT_PAYOUT_PROVIDER
      && evidence.payout_reconciliation.execution_adapter
        === PILOT_PAYOUT_EXECUTION_ADAPTER
      && evidence.payout_reconciliation.contract_version
        === PILOT_PAYOUT_RECONCILIATION_CONTRACT
      && evidence.payout_reconciliation.reference_contract
        === PILOT_PAYOUT_REFERENCE_CONTRACT
      && isEvidenceReference(
        evidence.payout_reconciliation
          .statement_completeness_evidence,
        nowMs,
      )
      && evidence.payout_reconciliation.beneficiary_registry_status
        === 'maker_checker_verified'
      && evidence.payout_reconciliation.beneficiary_binding_contract
        === PILOT_PAYOUT_BENEFICIARY_BINDING_CONTRACT
      && Number.isSafeInteger(
        evidence.payout_reconciliation.beneficiary_hmac_key_version,
      )
      && isEvidenceReference(
        evidence.payout_reconciliation
          .beneficiary_registry_evidence,
        nowMs,
    ),
    'revolut_manual_statement_import_not_verified',
  );
  require(
    evidence.payout_reconciliation.incident_resolution_status
      === 'maker_checker_verified'
      && isEvidenceReference(
        evidence.payout_reconciliation
          .incident_resolution_evidence,
        nowMs,
      ),
    'revolut_manual_incident_resolution_not_verified',
  );
  require(
    evidence.payout_reconciliation.legacy_provider_crons_status
      === 'inactive'
      && isEvidenceReference(
        evidence.payout_reconciliation
          .legacy_provider_crons_evidence,
        nowMs,
      ),
    'legacy_provider_payout_crons_not_disabled',
  );
  require(isEvidenceReference(evidence.quality.partners_ci_run_evidence, nowMs),
    'partners_ci_evidence_missing');
  require(evidence.quality.security_advisors_passed === true,
    'security_advisors_not_passed');
  require(evidence.quality.performance_advisors_passed === true,
    'performance_advisors_not_passed');
  require(
    isEvidenceReference(evidence.quality.offsite_backup_evidence, nowMs)
      && evidence.quality.offsite_backup_encrypted === true,
    'encrypted_offsite_backup_not_proven',
  );
  require(
    isEvidenceReference(evidence.quality.restore_drill_evidence, nowMs)
      && evidence.quality.restore_verifier_passed === true,
    'restore_drill_not_proven',
  );
  require(isEvidenceReference(evidence.runtime.worker_cron_evidence, nowMs),
    'worker_cron_not_proven');
  require(
    evidence.runtime.shadow_observation.clean === true
      && isOrderedObservation(
        evidence.runtime.shadow_observation,
        0,
        nowMs,
      ),
    'shadow_reconciliation_not_clean',
  );
  require(
    isEvidenceReference(evidence.runtime.alert_and_recovery_evidence, nowMs),
    'alert_recovery_cycle_not_proven',
  );
  const approvalCutoff = pilotAuthorityCutoff(evidence);
  for (const approver of ['legal', 'risk', 'finance', 'operations']) {
    const approval = evidence.approvals[approver];
    const hasApproval = approval.approved === true
      && isEvidenceReference(approval.evidence, nowMs);
    require(hasApproval, `${approver}_approval_missing`);
    if (hasApproval) {
      require(
        approvalCutoff !== null
          && parseIsoTimestamp(approval.evidence.verified_at) > approvalCutoff,
        `${approver}_approval_predates_authoritative_evidence`,
      );
    }
  }
  return [...new Set(blockers)].sort();
}

function generalizationReadinessBlockers(evidence, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const blockers = pilotReadinessBlockers(evidence, { nowMs });
  if (
    evidence.release_gates.general_release_approved !== true
    || !isEvidenceReference(
      evidence.release_gates.general_release_evidence,
      nowMs,
    )
  ) {
    blockers.push('general_release_not_approved');
  } else {
    const decisionCutoff = generalReleaseCutoff(evidence);
    if (
      decisionCutoff === null
      || parseIsoTimestamp(
        evidence.release_gates.general_release_evidence.verified_at,
      ) <= decisionCutoff
    ) {
      blockers.push(
        'general_release_approval_predates_pilot_or_payout_evidence',
      );
    }
  }
  if (
    evidence.runtime.pilot_observation.observed_days < 45
    || !isOrderedObservation(
      evidence.runtime.pilot_observation,
      45,
      nowMs,
    )
  ) {
    blockers.push('pilot_45_day_observation_not_proven');
  }
  for (const cycle of evidence.payout_cycles) {
    const completedAt = parseIsoTimestamp(cycle.period_completed_at);
    if (
      cycle.status !== PAYOUT_CYCLE_COMPLETE
      || parseIsoTimestamp(cycle.period_started_at) === null
      || completedAt === null
      || completedAt > nowMs
      || !isEvidenceReference(cycle.reconciliation_evidence, nowMs)
      || parseIsoTimestamp(cycle.reconciliation_evidence.verified_at)
        < completedAt
    ) {
      blockers.push(`payout_cycle_${cycle.sequence}_not_reconciled`);
    }
  }
  const [firstCycle, secondCycle] = evidence.payout_cycles;
  if (
    parseIsoTimestamp(firstCycle.period_completed_at) === null
    || parseIsoTimestamp(secondCycle.period_started_at) === null
    || parseIsoTimestamp(firstCycle.period_completed_at)
      >= parseIsoTimestamp(secondCycle.period_started_at)
  ) {
    blockers.push('payout_cycle_periods_overlap_or_unordered');
  }
  const pilotStartedAt = parseIsoTimestamp(
    evidence.runtime.pilot_observation.started_at,
  );
  const pilotCompletedAt = parseIsoTimestamp(
    evidence.runtime.pilot_observation.completed_at,
  );
  const firstCycleStartedAt = parseIsoTimestamp(firstCycle.period_started_at);
  const secondCycleCompletedAt = parseIsoTimestamp(
    secondCycle.period_completed_at,
  );
  if (
    pilotStartedAt === null
    || pilotCompletedAt === null
    || firstCycleStartedAt === null
    || secondCycleCompletedAt === null
    || firstCycleStartedAt < pilotStartedAt
    || secondCycleCompletedAt > pilotCompletedAt
  ) {
    blockers.push('payout_cycles_outside_pilot_observation');
  }
  return [...new Set(blockers)].sort();
}

function evaluateEvidence(evidence, options = {}) {
  validateEvidence(evidence, options);
  const pilotBlockers = pilotReadinessBlockers(evidence, options);
  const generalizationBlockers =
    generalizationReadinessBlockers(evidence, options);
  if (evidence.status === 'pilot_ready' && pilotBlockers.length) {
    throw new Error(
      `status pilot_ready contradicts blockers: ${pilotBlockers.join(', ')}`,
    );
  }
  if (
    evidence.status === 'generalization_ready'
    && generalizationBlockers.length
  ) {
    throw new Error(
      'status generalization_ready contradicts blockers: '
        + generalizationBlockers.join(', '),
    );
  }
  return { pilotBlockers, generalizationBlockers };
}

function parseCliArgs(args) {
  assert(Array.isArray(args), 'CLI arguments must be an array');
  let file = null;
  let requirePilot = false;
  let requireGeneralization = false;
  let expectedCommitSha = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-pilot-ready') {
      assert(!requirePilot, 'duplicate --require-pilot-ready');
      requirePilot = true;
      continue;
    }
    if (arg === '--require-generalization-ready') {
      assert(
        !requireGeneralization,
        'duplicate --require-generalization-ready',
      );
      requireGeneralization = true;
      continue;
    }
    if (arg === '--expected-commit-sha') {
      assert(expectedCommitSha === null, 'duplicate --expected-commit-sha');
      const value = args[index + 1];
      assert(value && !value.startsWith('--'),
        '--expected-commit-sha requires a value');
      assert(COMMIT_SHA.test(value),
        '--expected-commit-sha must be a lowercase 40-character Git SHA');
      expectedCommitSha = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--expected-commit-sha=')) {
      assert(expectedCommitSha === null, 'duplicate --expected-commit-sha');
      const value = arg.slice('--expected-commit-sha='.length);
      assert(COMMIT_SHA.test(value),
        '--expected-commit-sha must be a lowercase 40-character Git SHA');
      expectedCommitSha = value;
      continue;
    }
    assert(!arg.startsWith('--'), `unknown option: ${arg}`);
    assert(file === null, 'exactly one evidence file is required');
    file = arg;
  }
  assert(file !== null, 'exactly one evidence file is required');
  assert(
    !(requirePilot && requireGeneralization),
    'pilot and generalization readiness modes are mutually exclusive',
  );
  return {
    file,
    requirePilot,
    requireGeneralization,
    expectedCommitSha,
  };
}

if (require.main === module) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const file = path.resolve(process.cwd(), cli.file);
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cli.expectedCommitSha !== null) {
      assert(
        evidence.candidate_commit_sha === cli.expectedCommitSha,
        'candidate_commit_sha does not match --expected-commit-sha',
      );
    }
    if (cli.requirePilot) {
      assert(
        evidence.status === 'pilot_ready',
        '--require-pilot-ready requires status=pilot_ready',
      );
    }
    if (cli.requireGeneralization) {
      assert(
        evidence.status === 'generalization_ready',
        '--require-generalization-ready requires status=generalization_ready',
      );
    }
    const result = evaluateEvidence(evidence);
    const requiredBlockers = cli.requireGeneralization
      ? result.generalizationBlockers
      : result.pilotBlockers;
    if (
      (cli.requirePilot || cli.requireGeneralization)
      && requiredBlockers.length
    ) {
      console.error(JSON.stringify({
        status: 'blocked',
        blockers: requiredBlockers,
      }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({
      status: evidence.status,
      pilot_ready: result.pilotBlockers.length === 0,
      generalization_ready: result.generalizationBlockers.length === 0,
      pilot_blockers: result.pilotBlockers,
      generalization_blockers: result.generalizationBlockers,
    }, null, 2));
  } catch (error) {
    console.error(`Invalid Partners release evidence: ${error.message}`);
    console.error(
      'Usage: node scripts/validate-partners-release-evidence.js '
        + '<evidence.json> '
        + '[--require-pilot-ready|--require-generalization-ready] '
        + '[--expected-commit-sha=<40-lowercase-hex>]',
    );
    process.exit(1);
  }
}

module.exports = {
  evaluateEvidence,
  generalizationReadinessBlockers,
  isEvidenceReference,
  parseCliArgs,
  pilotReadinessBlockers,
  validateEvidence,
};
