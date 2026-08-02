'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('every Supabase migration has a unique version identifier', () => {
  const files = fs
    .readdirSync(path.join(root, 'supabase', 'migrations'))
    .filter((file) => /^\d{14}_.+\.sql$/.test(file))
    .sort();
  const byVersion = new Map();

  for (const file of files) {
    const version = file.slice(0, 14);
    const collisions = byVersion.get(version) || [];
    collisions.push(file);
    byVersion.set(version, collisions);
  }

  const duplicates = [...byVersion.entries()].filter(
    ([, collisions]) => collisions.length > 1,
  );
  assert.deepEqual(
    duplicates,
    [],
    `Supabase records only the 14-digit version; duplicate migrations: ${JSON.stringify(duplicates)}`,
  );
});

test('Didit provider-binding conflicts are quarantined and surfaced to operations', () => {
  const migration = read(
    'supabase/migrations/20260730100500_partners_didit_environment_binding.sql',
  );
  const opsProjection = migration.slice(
    migration.indexOf(
      'create or replace function affiliate_private.partners_ops_alert_snapshot()',
    ),
  );
  const worker = read('supabase/functions/norva-partners-worker/index.ts');

  assert.match(
    migration,
    /affiliate_kyc_webhook_events_binding_quarantine_recent_idx/,
  );
  assert.match(
    migration,
    /affiliate_events_kyc_binding_quarantine_recent_idx/,
  );
  assert.match(
    migration,
    /affiliate_events_kyc_binding_quarantine_once_idx/,
  );
  assert.match(
    migration,
    /affiliate_events_legacy_kyc_quarantine_recent_idx/,
  );
  assert.match(
    migration,
    /processing_outcome = 'quarantined'/,
  );
  assert.match(
    migration,
    /action = 'kyc_webhook_binding_conflict'/,
  );
  assert.match(
    opsProjection,
    /quarantined\.created_at >= now\(\) - interval '24 hours'/,
  );
  assert.match(
    opsProjection,
    /'kyc_provider_binding_quarantined_recent'[\s\S]*'critical'/,
  );
  assert.match(
    opsProjection,
    /'kyc_legacy_binding_quarantined_recent'[\s\S]*'critical'/,
  );
  assert.match(
    opsProjection,
    /'kyc_binding_recovery_overdue'[\s\S]*'critical'/,
  );
  assert.match(
    migration,
    /p_provider_session_ttl_seconds not between 3600 and 2419200/,
  );
  assert.match(
    migration,
    /when account\.status = 'active' then 'pending_verification'/,
    'legacy active accounts must re-enter the self-service KYC path fail-closed',
  );
  assert.match(
    migration,
    /'legacy_kyc_pending_session_expired'[\s\S]*status = 'expired'[\s\S]*provider_status = 'expired'[\s\S]*provider_environment = 'legacy_unbound'/,
    'unbound pending sessions must be terminalized with immutable audit evidence',
  );
  assert.match(migration, /affiliate_kyc_sessions_pending_expiry_idx/);
  assert.match(
    migration,
    /partners_service_kyc_binding_recover/,
  );
  assert.match(
    migration,
    /p_event_created_at >= v_session\.expires_at[\s\S]*kyc_session_local_expired[\s\S]*return affiliate_private\.partners_service_kyc_webhook_apply/,
    'late exact events must become terminal before the historical reducer runs',
  );
  assert.match(worker, /partners_service_kyc_binding_recover/);
  assert.match(
    migration,
    /v_event_hash,[\s\S]*'kyc_webhook_binding_conflict'[\s\S]*on conflict do nothing/,
    'replayed binding conflicts must have one idempotent audit incident',
  );
  assert.match(
    migration,
    /v_outcome = 'observed_sandbox'[\s\S]*status = 'superseded'/,
    'only a sandbox observation may close its own pending test session',
  );
  assert.doesNotMatch(
    migration,
    /v_outcome = 'quarantined'[\s\S]{0,300}status = 'superseded'/,
  );
  assert.doesNotMatch(
    opsProjection,
    /processing_outcome = 'observed_sandbox'/,
    'expected sandbox observations must not page production operations',
  );
  assert.match(
    migration.trimEnd(),
    /notify pgrst, 'reload schema';$/,
    'new public RPC overloads must be visible immediately after commit',
  );
});

test('Admin KYC analytics preserve the cumulative schema but count only immutable live evidence', () => {
  const migration = read(
    'supabase/migrations/20260730100500_partners_didit_environment_binding.sql',
  );
  const projection = migration.slice(
    migration.indexOf(
      'alter function affiliate_private.admin_partners_analytics(integer)',
    ),
    migration.indexOf(
      'revoke all on function\n  affiliate_private.admin_partners_analytics(integer)',
    ),
  );

  assert.match(
    projection,
    /rename to admin_partners_analytics_pre_didit_binding/,
  );
  assert.match(
    projection,
    /v_snapshot :=\s+affiliate_private\.admin_partners_analytics_pre_didit_binding\(p_days\)/,
    'the latest cumulative analytics envelope must remain the source projection',
  );
  assert.match(projection, /provider_environment = 'live'/);
  assert.match(
    projection,
    /provider_config_fingerprint\s+~ '\^\[0-9a-f\]\{64\}\$'/,
  );
  assert.match(projection, /processing_outcome = 'verified'/);
  assert.match(
    projection,
    /event\.provider_config_fingerprint =\s+session\.provider_config_fingerprint/,
  );
  assert.match(
    projection,
    /event\.provider_event_at = session\.verified_at/,
    'analytics must count the immutable event that caused the exact verification timestamp',
  );
  assert.doesNotMatch(
    projection,
    /account\.status = 'active'|link\.status = 'active'/,
    'historical verification metrics must not disappear after a later hold or link revocation',
  );
  assert.match(projection, /\{kyc_verified\}/);
  assert.match(
    projection,
    /\{activation,kyc_verified_sessions,value\}/,
  );
});

test('SQL lint temp-table template is empty, DML-blocked and private', () => {
  const migration = read(
    'supabase/migrations/20260730084500_sql_lint_runtime_fixes.sql',
  );

  assert.doesNotMatch(migration, /plpgsql\.enable_check/i);
  assert.match(migration, /create table if not exists public\._dp_upd/);
  assert.match(migration, /alter table public\._dp_upd enable row level security/);
  assert.match(migration, /revoke all on table public\._dp_upd[\s\S]*service_role/);
  assert.match(
    migration,
    /before insert or update or delete or truncate on public\._dp_upd/,
  );
  assert.match(
    migration,
    /replace\([\s\S]*'drop table if exists _dp_upd;'[\s\S]*'drop table if exists pg_temp\._dp_upd;'/,
  );
});

test('every logical application backup includes the private Partners schema and data', () => {
  const scripts = [
    'ops/backup/backup-to-r2.sh',
    'ops/hetzner/scripts/01-dump-prod.sh',
    'ops/hetzner/backup/backup-nightly.sh',
  ];

  for (const script of scripts) {
    const source = read(script);
    const occurrences = source.match(/--schema(?:=)?['"]?affiliate_private['"]?/g) || [];
    assert.ok(
      occurrences.length >= 2,
      `${script} must include affiliate_private in both schema-only and data-only dumps`,
    );
  }
  const nightly = read('ops/hetzner/backup/backup-nightly.sh');
  assert.match(nightly, /AFFILIATE_ACCOUNTS_COUNT="\$\([\s\S]*?to_regclass/);
  assert.match(nightly, /affiliate_accounts=\$AFFILIATE_ACCOUNTS_COUNT/);
  assert.doesNotMatch(nightly, /-Atc \\\\"select/);
});

test('restore procedures explicitly verify the Partners private schema', () => {
  const migrationRestore = read('ops/hetzner/scripts/02-restore-hetzner.sh');
  const disasterRestore = read('ops/hetzner/backup/RESTORE.md');
  const parity = read('ops/hetzner/scripts/05-verify-parity.sh');
  const verifier = read('ops/hetzner/backup/verify-partners-restore.sql');

  assert.match(migrationRestore, /PARTNERS_VERIFY=.*verify-partners-restore\.sql/);
  assert.match(
    migrationRestore,
    /psql "\$\{PSQL_TARGET\[@\]\}" -v ON_ERROR_STOP=1 -f "\$PARTNERS_VERIFY"/,
  );
  assert.match(
    migrationRestore,
    /PSQL_TARGET=\([\s\S]*-h 127\.0\.0\.1[\s\S]*-U postgres/,
  );
  assert.doesNotMatch(migrationRestore, /postgresql:\/\/postgres:\$\{POSTGRES_PASSWORD\}/);
  assert.match(disasterRestore, /affiliate_private\.affiliate_accounts/);
  assert.match(disasterRestore, /affiliate_private\.affiliate_events/);
  assert.match(disasterRestore, /verify-partners-restore\.sql/);
  assert.match(parity, /affiliate_private\.\$t/);
  assert.match(parity, /partners private tables/);
  assert.match(parity, /p\.proname like '%partners%'/);
  assert.match(parity, /affiliate_kyc_sessions affiliate_kyc_webhook_events/);
  assert.match(parity, /Didit binding columns/);
  assert.match(parity, /Didit legacy RPC grants/);
  assert.match(parity, /Didit unbound trust/);
  assert.match(parity, /Didit legacy pending/);
  assert.match(parity, /Didit recovery RPC grants/);
  assert.match(
    parity,
    /processing_outcome='verified'[\s\S]*provider_event_at=s\.verified_at/,
    'parity trust must require the immutable provider event that caused verification',
  );
  assert.match(parity, /affiliate_revolut_dispute_won_jobs/);
  assert.match(parity, /affiliate_revolut_dispute_won_conflicts/);
  assert.match(parity, /affiliate_revolut_manual_batches/);
  assert.match(parity, /affiliate_revolut_statement_imports/);
  assert.match(parity, /Revolut manual route violations/);
  assert.match(
    parity,
    /provider<>'revolut' or execution_adapter<>'revolut_manual'/,
  );
  assert.match(parity, /Revolut API flag enabled/);
  assert.match(parity, /partners_revolut_api_enabled' and enabled/);
  assert.match(
    parity,
    /NORVA_PARTNERS_REVOLUT_API_ENABLED:-false[\s\S]*must be false/,
  );
  assert.match(parity, /Revolut API active routes/);
  assert.match(parity, /execution_adapter='revolut_api'/);
  assert.match(parity, /Revolut payout reference duplicates/);
  assert.match(parity, /\^NORVA-\[A-F0-9\]\{12\}\$/);
  assert.match(verifier, /to_regnamespace\('affiliate_private'\)/);
  assert.match(verifier, /to_regclass\('affiliate_private\.' \|\| v_name\)/);
  assert.match(verifier, /and not c\.relrowsecurity/);
  assert.match(verifier, /has_schema_privilege\(\s*'anon'/);
  assert.match(verifier, /has_table_privilege\(/);
  assert.match(verifier, /has_sequence_privilege\(/);
  assert.match(verifier, /roles\.role_name = 'anon'/);
  assert.ok(
    (verifier.match(/\('service_role'::text\)/g) || []).length >= 2,
    'restore verification must reject direct private table and sequence grants to the Edge service role',
  );
  assert.match(verifier, /admin_partners_analytics\(integer\)'/);
  assert.match(
    verifier,
    /partners_worker_revolut_dispute_won_enqueue\(text,text,text,text,uuid,text,bigint,timestamp with time zone\)/,
  );
  assert.match(verifier, /affiliate_revolut_manual_batches/);
  assert.match(verifier, /affiliate_revolut_payout_executions/);
  assert.match(verifier, /affiliate_revolut_api_worker_lease/);
  assert.match(verifier, /affiliate_revolut_statement_imports/);
  assert.match(verifier, /affiliate_revolut_statement_rows/);
  assert.match(
    verifier,
    /affiliate_payout_provider_configs_pilot_adapter[\s\S]*provider = ''revolut''[\s\S]*execution_adapter[\s\S]*revolut_manual[\s\S]*revolut_api/,
  );
  assert.match(
    verifier,
    /config\.provider <> 'revolut'[\s\S]*config\.execution_adapter <> 'revolut_manual'/,
  );
  assert.match(
    verifier,
    /partners_revolut_api_enabled'[\s\S]*not flag\.enabled/,
  );
  assert.match(verifier, /restored Revolut API rail is not fail-closed/);
  assert.match(verifier, /admin_feature_flags_revolut_api_guard/);
  assert.match(
    verifier,
    /affiliate_payout_cycles_live_promotion_aal2[\s\S]*affiliate_payout_cycles[\s\S]*guard_partners_payout_live_promotion_aal2/,
    'restore drill must reject a missing or rewired DRY-to-LIVE AAL2 guard',
  );
  assert.match(
    verifier,
    /affiliate_revolut_payout_executions_reference[\s\S]*affiliate_revolut_statement_rows_reference/,
  );
  assert.match(verifier, /\^NORVA-\[A-F0-9\]\{12\}\$/);
  assert.match(
    verifier,
    /partners_payout_item_has_confirmed_settlement[\s\S]*invalid settled cycles/,
  );
  assert.match(
    verifier,
    /restored Revolut reconciliation contains % invalid decisions/,
  );
  assert.match(
    verifier,
    /admin_partners_revolut_manual_batch_prepare\(text,text,text\)/,
  );
  assert.match(
    verifier,
    /v_signature = any \(array\[[\s\S]*public\.admin_partners_revolut_beneficiary_binding_authorize\(uuid,text,text,text,text,integer,text,text\)[\s\S]*retired split\/manual Revolut routine remains callable/,
    'restore verification must keep the legacy account-UUID beneficiary authorizer closed',
  );
  const privateExecuteError = verifier.indexOf(
    'unexpected private Partners EXECUTE privilege',
  );
  const privateExecuteAllowlistStart = verifier.lastIndexOf(
    'from unnest(array[',
    privateExecuteError,
  );
  const privateExecuteAllowlistEnd = verifier.indexOf(
    ']) allowed(signature)',
    privateExecuteAllowlistStart,
  );
  const privateExecuteAllowlist = verifier.slice(
    privateExecuteAllowlistStart,
    privateExecuteAllowlistEnd,
  );
  for (const signature of [
    'affiliate_private.admin_partners_access_requests(integer,integer,text,text)',
    'affiliate_private.admin_partners_access_request_decide(uuid,text,timestamp with time zone,text)',
    'affiliate_private.admin_partners_detail_by_public_id(text)',
    'affiliate_private.admin_partners_fiscal_profiles(integer,integer,text,text)',
    'affiliate_private.admin_partners_fiscal_review_by_public_id(text,text,text,text,text,text)',
    'affiliate_private.admin_partners_payout_onboarding_requests(integer,integer,text,text)',
    'affiliate_private.admin_partners_payout_onboarding_request_decide(text,text,text,text)',
    'affiliate_private.admin_partners_payout_onboarding_contact(text,text,uuid)',
    'affiliate_private.admin_partners_revolut_beneficiary_binding_authorize_by_request(text,text,text,text,integer,text,text)',
  ]) {
    assert.ok(
      privateExecuteAllowlist.includes(`'${signature}'`),
      `${signature} must remain in the audited authenticated private-RPC allowlist`,
    );
  }
  assert.match(
    verifier,
    /partners_worker_revolut_payout_lease\(text,text,bigint,integer,integer\)/,
  );
  assert.match(verifier, /unexpected private Partners EXECUTE privilege/);
  assert.match(
    verifier,
    /restore omitted or left unvalidated DISPUTE_WON constraints/,
  );
  assert.match(
    verifier,
    /restored cumulative Partners Ops snapshot is incomplete/,
  );
  assert.match(verifier, /kyc_provider_binding_quarantined_recent/);
  assert.match(verifier, /kyc_legacy_binding_quarantined_recent/);
  assert.match(verifier, /kyc_binding_recovery_overdue/);
  assert.match(
    verifier,
    /restored Partners analytics lost authoritative Didit causality/,
  );
  assert.match(verifier, /affiliate_kyc_sessions_00_bind_environment/);
  assert.match(
    verifier,
    /affiliate_kyc_webhook_events_append_only[\s\S]*reject_partners_append_only_mutation/,
    'restored causal webhook evidence must remain append-only',
  );
  assert.match(
    verifier,
    /restored pre-binding Didit service overload remains callable/,
  );
  assert.match(
    verifier,
    /Didit decisions without an exact live binding/,
  );
  assert.match(
    verifier,
    /indefinitely blocking legacy KYC sessions/,
    'a restored database must reject unbound pending sessions that can block self-service',
  );
  assert.match(
    verifier,
    /event\.processing_outcome = 'verified'[\s\S]*event\.provider_environment = 'live'[\s\S]*event\.provider_config_fingerprint =\s+session\.provider_config_fingerprint[\s\S]*event\.provider_event_at = session\.verified_at/,
    'restore trust requires immutable verified webhook evidence for the exact live binding and decision timestamp',
  );
  assert.match(
    verifier,
    /restored Didit audit contains % invalid environment decisions/,
  );
  assert.match(verifier, /affiliate_financial_facts_append_only/);
  assert.match(verifier, /affiliate_commission_entry_balance_on_posting/);
  assert.match(verifier, /restored Partners ledger contains % unbalanced entries/);
});

test('Partners legal surfaces disclose KYC minimization and commission reversals', () => {
  const privacy = read('public/privacy.html');
  const terms = read('public/terms.html');
  const partnersTerms = read('public/partners-terms.html');
  const disclosure = read(
    'ops/partners/disclosures/partners-disclosure-v1.txt',
  ).trim();

  assert.match(privacy, /<strong>Didit<\/strong>/);
  assert.match(privacy, /does not store identity-document images, biometric captures/i);
  assert.match(terms, /href="\/partners-terms\.html"/);
  assert.match(partnersTerms, /20% of eligible Norva subscription payments/);
  assert.match(partnersTerms, /refunds, chargebacks, reversals/i);
  assert.match(partnersTerms, /not currently a\s+business\/KYB programme/i);
  assert.match(partnersTerms, /Minimum plain-language disclosure/);
  assert.match(partnersTerms, /separately itemized discount is optional context/i);
  assert.match(partnersTerms, /USD 10\.00 \(1,000 minor units\)/);
  assert.match(partnersTerms, /transfer fees charged to Norva[\s\S]*paid\s+by Norva[\s\S]*not deducted/i);
  assert.ok(
    partnersTerms.replace(/\s+/g, ' ').includes(disclosure),
    'repository Partners Terms must carry the exact versioned disclosure before publication',
  );
  assert.match(privacy, /<strong>Google Play<\/strong>/);
  assert.match(privacy, /<strong>RevenueCat<\/strong>/);
  assert.match(privacy, /<strong>Revolut<\/strong>/);
  assert.doesNotMatch(terms, /ec\.europa\.eu\/consumers\/odr/);
  assert.match(terms, /consumer-redress\.ec\.europa\.eu\/index_en/);
});

test('runbook keeps every release gate fail-closed and includes restore and pilot cycles', () => {
  const runbook = read('docs/NORVA-PARTNERS-RUNBOOK.md');
  const observability = read(
    'docs/NORVA-PARTNERS-OBSERVABILITY-CONTRACT.md',
  );

  assert.match(runbook, /partners_payouts_live=false/);
  assert.match(runbook, /partners_shadow_mode=true/);
  assert.match(runbook, /`revolut_manual` est le rail réel/i);
  assert.match(
    runbook,
    /provider=revolut` et[\s\S]*execution_adapter=revolut_manual/,
  );
  assert.match(
    runbook,
    /NORVA-\[A-F0-9\]\{12\}[\s\S]*référence, montant mineur et devise/i,
  );
  assert.match(runbook, /relevé brut est traité en mémoire/i);
  assert.match(
    runbook,
    /deux acteurs Finance distincts[\s\S]*revue[\s\S]*décision finale/i,
  );
  assert.match(
    runbook,
    /partners_revolut_api_enabled=false[\s\S]*NORVA_PARTNERS_REVOLUT_API_ENABLED=false/,
  );
  assert.match(
    runbook,
    /REVOLUT_BUSINESS_CLIENT_ID[\s\S]*REVOLUT_BUSINESS_PRIVATE_KEY_PEM[\s\S]*REVOLUT_BUSINESS_REFRESH_TOKEN[\s\S]*restent absents en[\s\S]*`revolut_manual`/,
  );
  assert.match(runbook, /affiliate_private/);
  assert.match(runbook, /deux premiers cycles/i);
  assert.match(runbook, /aucune fonction privée exécutable par `anon`/i);
  assert.match(runbook, /aucun accès direct table ou séquence/i);
  assert.match(runbook, /NORVA-PARTNERS-RELEASE-EVIDENCE\.md/);
  assert.match(runbook, /NORVA-PARTNERS-OBSERVABILITY-CONTRACT\.md/);
  assert.match(runbook, /Matrice mondiale candidate sous Revolut Basic/);
  assert.match(runbook, /`candidate_disabled`[\s\S]*`unsupported_provider`[\s\S]*`active`/);
  assert.match(runbook, /EUR\/SEPA reste nécessaire[\s\S]*Google Play restent dans leur devise autoritative/);
  assert.match(runbook, /aucune promesse de disponibilité/);
  assert.match(
    runbook,
    /DIDIT_SESSION_EXPIRATION_SECONDS[\s\S]*3600[\s\S]*2419200[\s\S]*604800/,
    'the runbook must bound and recommend the hosted-session lifetime',
  );
  assert.match(
    runbook,
    /session_expiration_time[\s\S]*config_fingerprint_sha256[\s\S]*change-control/,
    'Didit workflow expiry must be exact, fingerprinted and change-controlled',
  );
  assert.match(
    observability + read('docs/NORVA-PARTNERS-RELEASE-EVIDENCE.md'),
    /Un simple code HTTP `200` n'est pas suffisant/,
  );
  assert.match(observability, /status: unavailable/);
  assert.match(observability, /15 minutes/);
  assert.match(observability, /400\/500/);
  assert.match(observability, /500\/500/);
  assert.match(observability, /financial_transfer_quarantined_recent/);
  assert.match(observability, /revenuecat_transfer/);
  assert.match(observability, /heartbeat provider `payout`/);
  assert.match(observability, /not_configured/);
  assert.match(observability, /`payout_thresholds\.USD = 1000`/);
  assert.match(observability, /chaque devise de\s+règlement autorisée possède aussi son propre seuil entier/i);
  assert.match(observability, /toujours `borne_by = platform`/);
  assert.match(observability, /aucun total multi-devise n'est publié sans preuve FX autoritative/i);
});

test('Partners CI covers exact Google money, deletion and release evidence', () => {
  const workflow = read('.github/workflows/partners-integration.yml');
  assert.match(workflow, /tests\/google-play-orders-partners\.test\.js/);
  assert.match(
    workflow,
    /supabase\/functions\/norva-account-delete\/index\.ts/,
  );
  assert.match(
    workflow,
    /node scripts\/validate-partners-release-evidence\.js[\s\S]*?ops\/partners\/pilot-release\.example\.json/,
  );
  assert.match(workflow, /ops\/hetzner\/backup\/\*\*/);
  assert.match(
    workflow,
    /bash -n[\s\S]*?backup-nightly\.sh[\s\S]*?01-dump-prod\.sh[\s\S]*?05-verify-parity\.sh/,
  );
});

test('protected Partners release gate uses private evidence and exact commit', () => {
  const release = read('.github/workflows/partners-release-gate.yml');
  const integration = read('.github/workflows/partners-integration.yml');
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /\bpush:|\bpull_request:/);
  assert.match(release, /environment: Partners Release/);
  assert.match(
    release,
    /reject-noncanonical-dispatch:[\s\S]*?permissions: \{\}[\s\S]*?exit 1/,
  );
  assert.match(
    release,
    /if: >-\s+github\.repository == 'Admin-Adher\/Norva'\s+&& github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(release, /permissions:\s*\n\s*contents: read/);
  assert.match(
    release,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/,
  );
  assert.match(
    release,
    /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/,
  );
  assert.match(release, /node-version: 22\.22\.3/);
  assert.match(
    release,
    /secrets\.PARTNERS_RELEASE_EVIDENCE_B64/,
  );
  assert.match(release, /umask 077/);
  assert.match(release, /evidence_dir="\$\(mktemp -d\)"/);
  assert.match(
    release,
    /trap 'rm -f "\$evidence_file"; rmdir "\$evidence_dir"' EXIT/,
  );
  assert.match(release, /canonicalBase64/);
  assert.match(release, /decoded\.toString\('base64'\) !== encoded/);
  assert.match(release, /flag: 'wx'/);
  assert.match(release, /unset PARTNERS_RELEASE_EVIDENCE_B64/);
  assert.match(release, /--require-pilot-ready/);
  assert.match(release, /--require-generalization-ready/);
  assert.match(release, /--expected-commit-sha=\$\{GITHUB_SHA\}/);
  assert.match(release, /GITHUB_REPOSITORY" != "Admin-Adher\/Norva"/);
  assert.match(release, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.ok(
    release.indexOf('GITHUB_REPOSITORY')
      < release.indexOf('PARTNERS_RELEASE_EVIDENCE_B64'),
    'canonical repository/ref must be checked before protected evidence is decoded',
  );
  assert.doesNotMatch(release, /cat "\$evidence_file"|echo "\$PARTNERS_RELEASE/);
  assert.match(
    integration,
    /ops\/partners\/pilot-release\.example\.json/,
  );
  assert.doesNotMatch(
    integration,
    /--require-pilot-ready|--require-generalization-ready/,
  );
});

test('Partners callback changes trigger CI and every norva-web deploy is pinned', () => {
  const integration = read('.github/workflows/partners-integration.yml');
  const deploy = read('.github/workflows/deploy-cloudflare.yml');
  const blog = read('.github/workflows/blog-autopublish.yml');
  const relay = read('.github/workflows/deploy-relay.yml');
  for (const expectedPath of [
    "'.github/workflows/partners-release-gate.yml'",
    "'.github/workflows/deploy-cloudflare.yml'",
    "'.github/workflows/deploy-relay.yml'",
    "'functions/partners-kyc-return.js'",
    "'public/sw.js'",
  ]) {
    assert.equal(
      integration.split(expectedPath).length - 1,
      2,
      `${expectedPath} must trigger Partners CI on pull requests and main`,
    );
  }

  for (const [name, workflow] of [
    ['deploy-cloudflare', deploy],
    ['blog-autopublish', blog],
  ]) {
    const actionRefs = [
      ...workflow.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)/gm),
    ]
      .map((match) => match[1]);
    assert.ok(actionRefs.length >= 3, `${name} must declare its actions`);
    assert.ok(
      actionRefs.every((reference) => /@[a-f0-9]{40}$/.test(reference)),
      `${name} actions must be pinned to immutable commit SHAs`,
    );
    assert.match(workflow, /npm ci --ignore-scripts/);
    assert.match(workflow, /npm test/);
    assert.match(
      workflow,
      /test "\$\(npx --no-install wrangler --version\)" = "4\.102\.0"/,
    );
    assert.match(workflow, /npx --no-install wrangler pages functions build functions/);
    assert.match(workflow, /routes\.include\.includes\('\/partners-kyc-return'\)/);
    assert.ok(
      workflow.indexOf('pages functions build functions')
        < workflow.indexOf('cloudflare/wrangler-action@'),
      `${name} must compile Pages Functions before deploying`,
    );
  }

  assert.match(deploy, /permissions:\s*\n\s*contents: read/);
  assert.match(deploy, /persist-credentials: false/);
  assert.match(relay, /permissions:\s*\n\s*contents: read/);
  assert.match(relay, /persist-credentials: false/);
  assert.match(relay, /node-version: '22\.22\.3'/);
  assert.match(relay, /wranglerVersion: '4\.102\.0'/);
  const relayActionRefs = [
    ...relay.matchAll(/^[ \t]*(?:-[ \t]+)?uses:[ \t]*(\S+)/gm),
  ]
    .map((match) => match[1]);
  assert.ok(
    relayActionRefs.length === 3
      && relayActionRefs.every((reference) => /@[a-f0-9]{40}$/.test(reference)),
    'deploy-relay actions must be pinned to immutable commit SHAs',
  );
  assert.match(blog, /name: Publish due articles[\s\S]*?contents: write/);
  assert.match(
    blog,
    /name: Validate and deploy the exact blog commit[\s\S]*?contents: read/,
  );
  assert.match(
    blog,
    /ref: \$\{\{ needs\.publish\.outputs\.commit_sha \}\}[\s\S]*?persist-credentials: false/,
  );
});

test('Partners CI freezes Edge dependencies and replays a blank database', () => {
  const workflow = read('.github/workflows/partners-integration.yml');
  const denoConfig = JSON.parse(
    read('supabase/functions/deno.partners.json'),
  );
  const denoLock = JSON.parse(
    read('supabase/functions/deno.partners.lock'),
  );
  const extensionMigration = read(
    'supabase/migrations/20260617100000_required_runtime_extensions.sql',
  );
  const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

  assert.match(
    workflow,
    /deno check[\s\S]*?--config supabase\/functions\/deno\.partners\.json[\s\S]*?--frozen/,
  );
  assert.match(
    workflow,
    /supabase\/functions\/norva-partners-revolut-payout\/index\.ts/,
  );
  assert.match(
    workflow,
    /supabase\/tests\/affiliate_revolut_manual_hybrid\.sql/,
  );
  assert.match(
    workflow,
    /supabase\/tests\/affiliate_member_write_rate_limits\.sql/,
  );
  assert.match(
    workflow,
    /ops\/hetzner\/volumes\/api\/kong\.yml/,
  );
  assert.match(
    workflow,
    /supabase\/functions\/_shared\/didit-partners\.test\.ts/,
  );
  assert.equal(denoConfig.lock.path, './deno.partners.lock');
  assert.equal(denoConfig.lock.frozen, true);
  assert.equal(
    denoConfig.imports['jsr:@panva/jose@6'],
    'jsr:@panva/jose@6.2.4',
  );
  assert.equal(
    denoConfig.imports['npm:@supabase/supabase-js@2'],
    'npm:@supabase/supabase-js@2.108.1',
  );
  assert.equal(denoLock.specifiers['jsr:@panva/jose@6.2.4'], '6.2.4');
  assert.equal(
    denoLock.specifiers['npm:@supabase/supabase-js@2.108.1'],
    '2.108.1',
  );

  assert.match(workflow, /run: supabase db start/);
  assert.match(
    workflow,
    /supabase db reset --local --no-seed/,
  );
  assert.doesNotMatch(workflow, /run: supabase start/);
  assert.doesNotMatch(workflow, /supabase db query/);
  assert.match(
    extensionMigration,
    /create extension if not exists pg_cron with schema pg_catalog/,
  );
  assert.match(
    extensionMigration,
    /create extension if not exists pg_net with schema extensions/,
  );

  assert.match(deploy, /mapfile -t configured_functions/);
  assert.match(deploy, /if \(\( missing != 0 \)\); then/);
  assert.match(deploy, /exit 1/);
});

test('offsite Partners backup is scheduled, least-privilege and secret-backed', () => {
  const workflow = read('.github/workflows/backup-db-to-r2.yml');
  assert.match(workflow, /cron: '15 3 \* \* \*'/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /postgresql-client-17/);
  assert.match(workflow, /bash ops\/backup\/backup-to-r2\.sh/);
  assert.match(workflow, /BACKUP_ENCRYPTION_REQUIRED: 'true'/);
  assert.match(
    read('ops/backup/backup-to-r2.sh'),
    /BACKUP_ENCRYPTION_REQUIRED[\s\S]*BACKUP_AGE_RECIPIENT is required/,
  );
  for (const secret of [
    'SUPABASE_DB_URL',
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET',
    'BACKUP_AGE_RECIPIENT',
  ]) {
    assert.match(
      workflow,
      new RegExp(`${secret}: \\\${{ secrets\\.${secret} }}`),
    );
  }
  assert.doesNotMatch(workflow, /pull_request:/);
});

test('self-hosted Edge runtimes receive the complete fail-closed Partners configuration surface', () => {
  const compose = read('ops/hetzner/docker-compose.supabase.yml');
  const example = read('ops/hetzner/.env.hetzner.example');
  const required = [
    'NORVA_PARTNERS_ALLOWED_ORIGINS',
    'NORVA_PARTNERS_DEVICE_ALLOWED_ORIGINS',
    'NORVA_REFERRAL_EDGE_HMAC_SECRET',
    'NORVA_REFERRAL_COOKIE_SECRET',
    'NORVA_PARTNERS_TV_RELAY_SECRET',
    'NORVA_PARTNERS_TV_RELAY_HANDOFF_URL',
    'NORVA_PARTNERS_TV_RELAY_TTL_SECONDS',
    'NORVA_PARTNERS_WORKER_BATCH',
    'NORVA_PARTNERS_WORKER_MAX_BATCHES',
    'NORVA_PARTNERS_WORKER_LEASE_SECONDS',
    'NORVA_PARTNERS_SHADOW_WINDOW_HOURS',
    'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    'GOOGLE_PLAY_PACKAGE_NAME',
    'DIDIT_API_KEY',
    'DIDIT_WORKFLOW_ID',
    'DIDIT_APPLICATION_ID',
    'DIDIT_ENVIRONMENT',
    'DIDIT_SESSION_EXPIRATION_SECONDS',
    'DIDIT_WEBHOOK_SECRET',
    'DIDIT_CALLBACK_URL',
    'DIDIT_ID_VERIFICATION_NODE_ID',
    'DIDIT_LIVENESS_NODE_ID',
    'DIDIT_FACE_MATCH_NODE_ID',
  ];

  for (const name of required) {
    assert.match(compose, new RegExp(`\\b${name}:`), `${name} must be forwarded to Edge`);
    assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} must be documented`);
  }
  assert.match(compose, /environment:\s+\*functions-env/, 'the second Edge runtime must inherit the same secrets');
  assert.match(
    example,
    /^DIDIT_CALLBACK_URL="https:\/\/norva\.tv\/partners-kyc-return"$/m,
    'the self-host example must use the exact query-free Didit return boundary',
  );
  assert.match(
    example,
    /^DIDIT_SESSION_EXPIRATION_SECONDS=604800$/m,
  );
  assert.doesNotMatch(
    example,
    /^DIDIT_CALLBACK_URL=.*(?:app\.html|#partners|\?)/m,
  );
  assert.match(example, /Generate two different values/);
});

test('USD reference and absorbed payout costs stay exact-money and fail-closed', () => {
  const migration = read(
    'supabase/migrations/20260801202253_partners_usd_reference_fx_payout.sql',
  );

  assert.match(
    migration,
    /threshold_reference_currency set default 'USD'/,
  );
  assert.match(
    migration,
    /threshold_reference_minor set default 1000/,
  );
  assert.match(
    migration,
    /payout_fee_policy set default 'platform_absorbed'/,
  );
  assert.match(
    migration,
    /partners_fx_value_floor\([\s\S]*floor\(/,
  );
  assert.match(
    migration,
    /affiliate_payout_cost_facts_platform_only[\s\S]*borne_by = 'platform'/,
  );
  assert.match(
    migration,
    /affiliate_currency_metadata_identity_immutable[\s\S]*guard_affiliate_currency_identity/,
  );
  assert.match(
    migration,
    /entry\.currency_exponent is distinct from v_balance_exponent/,
  );
  assert.match(
    migration,
    /rate\.source_exponent = v_balance_exponent[\s\S]*rate\.target_exponent = v_reference_exponent/,
  );
  assert.match(
    migration,
    /rate\.source_currency = v_payout_currency[\s\S]*rate\.target_currency = v_cost_currency[\s\S]*rate\.valid_until >= p_observed_at/,
  );
  assert.match(
    migration,
    /p_observed_at < now\(\) - interval '5 minutes'/,
  );
  assert.match(
    migration,
    /FX evidence requires AAL2/,
  );
  assert.match(
    migration,
    /payout cost evidence requires AAL2/,
  );
  assert.match(
    migration,
    /These record evidence only; no RPC below can[\s\S]*move ledger balances or call Revolut/,
  );
  assert.doesNotMatch(
    migration,
    /partners_payouts_live[^\n]*true|partners_revolut_api_enabled[^\n]*true/,
  );
});
