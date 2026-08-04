const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('member Didit capture uses a dedicated versioned biometric consent', () => {
  const page = read('public/js/pages/PartnersPage.js');
  const cloud = read('public/js/cloudApi.js');
  const edge = read('supabase/functions/norva-partners/index.ts');
  const api = read('supabase/functions/_shared/partners-api.ts');
  const migration = read(
    'supabase/migrations/20260804084500_partners_biometric_consent_contract.sql',
  );
  const version = 'partners-biometric-consent-v1';

  assert.match(page, new RegExp(`BIOMETRIC_CONSENT_VERSION = '${version}'`));
  assert.match(page, /biometricConsentVersion: PartnersPage\.BIOMETRIC_CONSENT_VERSION/);
  assert.match(cloud, new RegExp(`safeBiometricConsentVersion !== '${version}'`));
  assert.match(api, /kycPrepare: "partners_service_kyc_prepare_v2"/);
  assert.match(edge, /p_biometric_consent_version: input\.biometricConsentVersion/);
  assert.match(migration, new RegExp(version, 'g'));
  assert.match(migration, /affiliate_biometric_consent_append_only/);
  assert.match(migration, /kyc_biometric_consent_attested/);
  assert.match(migration, /reservation_key_sha256/);
  assert.match(migration, /partners_service_kyc_session_record_v2/);
  assert.match(migration, /p_provider_environment text/);
  assert.match(migration, /p_provider_config_fingerprint text/);
  assert.match(migration, /p_provider_session_ttl_seconds integer/);
  assert.match(api, /kycSessionRecord: "partners_service_kyc_session_record_v3"/);
  assert.match(edge, /encryptDiditPurgeEnvelope/);
  assert.match(edge, /p_provider_session_envelope: providerSessionEnvelope/);
  assert.match(edge, /recorded\.session_disposition === "withdrawn"/);
  assert.match(page, /biometric_consent_withdrawn:/);
  const enforcement = read(
    'supabase/migrations/20260804170000_partners_biometric_consent_enforcement.sql',
  );
  assert.match(
    enforcement,
    /revoke execute on function public\.partners_service_kyc_prepare\(/,
  );
  assert.match(
    enforcement,
    /revoke execute on function public\.partners_service_kyc_session_record\(/,
  );
  assert.match(
    enforcement,
    /partners_service_kyc_session_record\([\s\S]*text, text, integer[\s\S]*from service_role/,
  );
  assert.match(
    enforcement,
    /partners_service_kyc_session_record_v2\([\s\S]*from service_role/,
  );
});

test('the browser never substitutes general disclosure acceptance for biometric consent', () => {
  const page = read('public/js/pages/PartnersPage.js');
  const cloud = read('public/js/cloudApi.js');

  assert.doesNotMatch(
    page,
    /biometricConsentVersion:\s*data\.policy\.disclosure_version/,
  );
  assert.match(cloud, /biometricConsentVersion: safeBiometricConsentVersion/);
  assert.match(cloud, /consentVersion: safeConsentVersion/);
});
