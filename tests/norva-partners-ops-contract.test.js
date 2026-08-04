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
  assert.match(nightly, /schema_acl_statements=\$\(grep -Ec/);
  assert.match(nightly, /schema dump contains no ACL statements/);
  assert.doesNotMatch(
    nightly,
    /--schema-only --no-owner --no-privileges[\s\S]*?--schema=public/,
  );
  assert.doesNotMatch(nightly, /-Atc \\\\"select/);
});

test('self-hosted nightly dumps are age-encrypted and verified before plaintext cleanup', () => {
  const nightly = read('ops/hetzner/backup/backup-nightly.sh');
  const envExample = read('ops/hetzner/backup/norva-backup.env.example');
  const restore = read('ops/hetzner/backup/RESTORE.md');

  assert.match(nightly, /BACKUP_ENCRYPTION_REQUIRED="\$\{BACKUP_ENCRYPTION_REQUIRED:-false\}"/);
  assert.match(nightly, /BACKUP_ENCRYPTION_REQUIRED must be true or false/);
  assert.match(
    nightly,
    /BACKUP_ENCRYPTION_REQUIRED" == "true"[\s\S]*BACKUP_AGE_RECIPIENT is required/,
  );
  assert.match(nightly, /command -v age[\s\S]*age is required/);
  assert.match(
    nightly,
    /age --recipient "\$BACKUP_AGE_RECIPIENT" --output "\$\{ARCHIVE\}\.age" "\$ARCHIVE"/,
  );
  assert.match(nightly, /REMOTE="r2:[\s\S]*\$\(basename "\$UPLOAD"\)"/);
  assert.match(nightly, /rclone copyto "\$UPLOAD" "\$REMOTE" --retries 4/);
  assert.match(nightly, /rclone lsl "\$REMOTE" --retries 4/);
  assert.match(nightly, /REMOTE_BYTES[\s\S]*LOCAL_BYTES[\s\S]*exit 1/);
  assert.match(nightly, /UPLOAD_VERIFIED=false[\s\S]*UPLOAD_VERIFIED=true/);
  assert.match(
    nightly,
    /R2 upload was not verified; local backup retained at \$STAGE/,
  );

  const verified = nightly.indexOf('UPLOAD_VERIFIED=true', nightly.indexOf('rclone copyto'));
  const plaintextRemoval = nightly.indexOf('rm -f "$ARCHIVE"');
  const retention = nightly.indexOf('retention: keep');
  assert.ok(verified > 0, 'the remote object must reach a verified state');
  assert.ok(
    plaintextRemoval > verified,
    'the plaintext archive must remain until the encrypted upload is verified',
  );
  assert.ok(retention > verified, 'retention must only run after upload verification');

  assert.match(envExample, /^BACKUP_ENCRYPTION_REQUIRED=true$/m);
  assert.match(envExample, /^BACKUP_AGE_RECIPIENT=age1CHANGE_ME$/m);
  assert.match(restore, /BACKUP_AGE_IDENTITY_FILE/);
  assert.match(
    restore,
    /age --decrypt --identity "\$BACKUP_AGE_IDENTITY_FILE"[\s\S]*--output \.\/restore\.tar\.gz/,
  );
  assert.match(restore, /sha256sum -c SHA256SUMS/);
});

test('restore procedures explicitly verify the Partners private schema', () => {
  const migrationRestore = read('ops/hetzner/scripts/02-restore-hetzner.sh');
  const disasterRestore = read('ops/hetzner/backup/RESTORE.md');
  const parity = read('ops/hetzner/scripts/05-verify-parity.sh');
  const verifier = read('ops/hetzner/backup/verify-partners-restore.sql');
  const certificationMigration = read(
    'supabase/migrations/20260803160730_partners_didit_certification_pre_gate.sql',
  );

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
  assert.match(disasterRestore, /grep -Ec '\^\(GRANT\|REVOKE\) '/);
  assert.match(disasterRestore, /schema_acl_statements=\[1-9\]/);
  assert.match(disasterRestore, /verify-partners-restore\.sql/);
  assert.match(
    verifier,
    /affiliate_private\.admin_partners_capability_operators\(\)/,
  );
  assert.match(
    verifier,
    /affiliate_private\.admin_partners_capability_set_by_operator_key\(text,text,boolean,text\)/,
  );
  assert.match(verifier, /affiliate_didit_session_registry/);
  assert.match(verifier, /affiliate_didit_certification_sessions/);
  assert.match(verifier, /affiliate_didit_certification_events/);
  assert.match(
    verifier,
    /outbox\.status = 'succeeded'[\s\S]*outbox\.provider_session_envelope is not null[\s\S]*outbox\.purged_at is null/,
    'successful Didit purge rows must be checked against the canonical purged_at timestamp',
  );
  assert.doesNotMatch(verifier, /outbox\.completed_at/);
  assert.match(
    certificationMigration,
    /constraint affiliate_didit_certification_sessions_binding/,
  );
  assert.match(
    verifier,
    /constraint_info\.conname =\s*'affiliate_didit_certification_sessions_binding'/,
    'restore verification must resolve the exact installed binding constraint',
  );
  assert.match(
    verifier,
    /partners_assert_didit_certification_pre_gate/,
  );
  assert.match(
    verifier,
    /partners_require_didit_certification_observer/,
  );
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
  assert.match(
    parity,
    /NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED:-false[\s\S]*must be false/,
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

test('physical Partners rehearsal is isolated, atomic and leaves only sanitized proof', () => {
  const rehearsal = read(
    'ops/hetzner/backup/rehearse-partners-physical.sh',
  );
  const restoreGuide = read('ops/hetzner/backup/RESTORE.md');
  const workflow = read('.github/workflows/partners-integration.yml');
  const restorePgTap = read(
    'supabase/tests/affiliate_restore_compatibility.sql',
  );

  assert.match(rehearsal, /if \[\[ "\$\{EUID\}" -ne 0 \]\]/);
  assert.match(rehearsal, /flock -n 9/);
  assert.match(rehearsal, /if \[\[ "\$#" -ne 2 \]\]/);
  assert.match(
    rehearsal,
    /REHEARSAL_MODE="\$\{1:-\}"[\s\S]*predeploy[\s\S]*postdeploy/,
  );
  assert.match(rehearsal, /TARGET_SHA="\$\{2:-\}"/);
  assert.match(rehearsal, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(rehearsal, /GIT=\(git -c "safe\.directory=\$REPO_ROOT" -C "\$REPO_ROOT"\)/);
  assert.match(rehearsal, /"\$\{GIT\[@\]\}" show "\$TARGET_SHA:\$candidate_file"/);
  assert.match(
    rehearsal,
    /PARTNERS_REHEARSAL_STAGE_DIR:-\$\{BACKUP_STAGE_DIR:-\/var\/lib\/norva\/backups\}/,
  );
  assert.match(rehearsal, /docker inspect --format '\{\{\.Image\}\}' "\$DB_CONTAINER"/);
  assert.match(rehearsal, /docker image inspect --format '\{\{\.Id\}\}' "\$PG_IMAGE"/);
  assert.match(rehearsal, /"\$LIVE_IMAGE_ID" != "\$PINNED_IMAGE_ID"/);

  assert.match(rehearsal, /--network none/);
  assert.doesNotMatch(rehearsal, /--network host|--publish|-p 5433/);
  assert.match(rehearsal, /-c "shared_preload_libraries=\$CLONE_PRELOADS"/);
  assert.match(rehearsal, /show shared_preload_libraries/);
  assert.match(rehearsal, /SAW_PG_CRON/);
  assert.match(rehearsal, /SAW_PG_NET/);
  assert.match(rehearsal, /cron\.database_name=__norva_rehearsal_disabled__/);
  assert.match(rehearsal, /begin read only/);
  assert.match(rehearsal, /backend_type ~\* '\(pg_cron\|pg_net\|cron scheduler\)'/);
  assert.match(rehearsal, /count\(\*\) filter \(where active\)/);
  assert.match(rehearsal, /cron_counts_unchanged=true/);
  assert.doesNotMatch(rehearsal, /update cron\.job set active/);
  assert.doesNotMatch(
    rehearsal,
    /timeout --signal=TERM --kill-after=30s "\$PSQL_TIMEOUT_SECONDS" \\\n\s+docker exec -i/,
  );
  assert.equal(
    (rehearsal.match(/docker exec -u postgres "\$DB_CONTAINER"/g) || []).length,
    2,
    'only the before/after read-only preload SHOW may execute in the live container',
  );
  assert.doesNotMatch(
    rehearsal,
    /docker exec -u postgres "\$DB_CONTAINER"[\s\S]{0,180}\b(?:insert|update|delete|alter|drop|truncate)\b/i,
  );
  assert.match(rehearsal, /live_health_before=healthy/);
  assert.match(rehearsal, /live_health_after=healthy/);

  assert.match(rehearsal, /mktemp -d "\$STAGE_ROOT\/\$\{WORKDIR_PREFIX\}XXXXXXXX"/);
  assert.match(rehearsal, /SAFE_WORKDIR_PREFIX/);
  assert.match(rehearsal, /docker rm -f "\$CONTAINER_NAME"/);
  assert.match(rehearsal, /rm -rf -- "\$WORKDIR"/);
  assert.match(
    rehearsal,
    /\^norva-partners-physical-rehearsal-\[0-9a-f\]\{8\}-\[0-9\]\+\$/,
  );

  assert.match(rehearsal, /--single-transaction/);
  assert.match(rehearsal, /-U supabase_admin -d postgres/);
  assert.match(rehearsal, /migration_routine_owner=supabase_admin/);
  assert.match(rehearsal, /ROUTINE_OWNER_CHECK/);
  const operatorCapabilitiesMigration = rehearsal.indexOf(
    '20260803082211_partners_admin_operator_capabilities.sql',
  );
  const accessDecisionEmailMigration = rehearsal.indexOf(
    '20260803084051_partners_access_request_decision_email.sql',
  );
  const diditCertificationMigration = rehearsal.indexOf(
    '20260803160730_partners_didit_certification_pre_gate.sql',
  );
  const releaseGateAal2Migration = rehearsal.indexOf(
    '20260803204442_partners_release_gate_aal2.sql',
  );
  const approvalRegistryMigration = rehearsal.indexOf(
    '20260804083541_partners_approval_registry.sql',
  );
  const biometricConsentMigration = rehearsal.indexOf(
    '20260804084500_partners_biometric_consent_contract.sql',
  );
  const diditPurgeMigration = rehearsal.indexOf(
    '20260804093000_partners_didit_purge_outbox.sql',
  );
  const privacyRightsMigration = rehearsal.indexOf(
    '20260804160000_partners_privacy_rights_human_review.sql',
  );
  const reverificationOverrideMigration = rehearsal.indexOf(
    '20260804165000_partners_kyc_reverification_override.sql',
  );
  const biometricEnforcementMigration = rehearsal.indexOf(
    '20260804170000_partners_biometric_consent_enforcement.sql',
  );
  assert.ok(
    operatorCapabilitiesMigration < accessDecisionEmailMigration
      && accessDecisionEmailMigration < diditCertificationMigration
      && diditCertificationMigration < releaseGateAal2Migration
      && releaseGateAal2Migration < approvalRegistryMigration
      && approvalRegistryMigration < biometricConsentMigration
      && biometricConsentMigration < diditPurgeMigration
      && diditPurgeMigration < privacyRightsMigration
      && privacyRightsMigration < reverificationOverrideMigration
      && reverificationOverrideMigration < biometricEnforcementMigration,
    'the ten pending Partners migrations must keep their atomic final-state replay order',
  );
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_THREE"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_FOUR"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_FIVE"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_SIX"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_SEVEN"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_EIGHT"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_NINE"/);
  assert.match(rehearsal, /-f "\/candidate\/\$MIGRATION_TEN"/);
  assert.match(rehearsal, /migration_three_sha256=/);
  assert.match(rehearsal, /migration_four_sha256=/);
  assert.match(rehearsal, /migration_five_sha256=/);
  assert.match(rehearsal, /migration_six_sha256=/);
  assert.match(rehearsal, /migration_seven_sha256=/);
  assert.match(rehearsal, /migration_eight_sha256=/);
  assert.match(rehearsal, /migration_nine_sha256=/);
  assert.match(rehearsal, /migration_ten_sha256=/);
  assert.match(rehearsal, /migration_markers_before=\$MIGRATION_MARKERS/);
  assert.match(rehearsal, /migration_markers_after=\$MIGRATION_MARKERS/);
  assert.match(rehearsal, /"0(?:\|0){20}"/);
  assert.match(rehearsal, /"1(?:\|1){20}"/);
  assert.match(
    rehearsal,
    /if \[\[ "\$REHEARSAL_MODE" == "predeploy" \]\]; then[\s\S]*EXPECTED_MARKERS_BEFORE="0(?:\|0){20}"[\s\S]*else[\s\S]*EXPECTED_MARKERS_BEFORE="1(?:\|1){20}"/,
  );
  assert.match(
    rehearsal,
    /MIGRATIONS_APPLIED=0[\s\S]*MIGRATION_REPLAY_SKIPPED="true"[\s\S]*if \[\[ "\$REHEARSAL_MODE" == "predeploy" \]\]; then[\s\S]*--single-transaction[\s\S]*MIGRATIONS_APPLIED=10[\s\S]*MIGRATION_REPLAY_SKIPPED="false"[\s\S]*fi/,
  );
  assert.equal(
    (rehearsal.match(/--single-transaction/g) || []).length,
    1,
    'only predeploy may execute the migration transaction',
  );
  assert.match(rehearsal, /migrations_applied=\$MIGRATIONS_APPLIED/);
  assert.match(
    rehearsal,
    /migration_replay_skipped=\$MIGRATION_REPLAY_SKIPPED/,
  );
  assert.match(rehearsal, /rehearsal_mode=\$REHEARSAL_MODE/);
  assert.match(rehearsal, /"\$ROUTINE_OWNER_CHECK" != "119\|0"/);
  assert.match(rehearsal, /migration_routines_verified=119/);
  assert.match(rehearsal, /"\$RELATION_OWNER_CHECK" != "14\|0"/);
  assert.match(rehearsal, /migration_relations_verified=14/);
  assert.match(rehearsal, /verify-partners-restore\.sql/);
  assert.match(rehearsal, /affiliate_restore_compatibility\.sql/);
  assert.match(workflow, /affiliate_restore_compatibility\.sql/);
  for (const pgTapFile of [
    'affiliate_p0.sql',
    'affiliate_access_requests.sql',
    'affiliate_dispute_won.sql',
    'affiliate_fiscal_payout_onboarding.sql',
    'affiliate_kyc_reverification_override.sql',
    'affiliate_member_write_rate_limits.sql',
    'affiliate_revolut_manual_hybrid.sql',
    'revenuecat_transfer.sql',
  ]) {
    assert.doesNotMatch(rehearsal, new RegExp(pgTapFile.replace('.', '\\.')));
    assert.match(workflow, new RegExp(pgTapFile.replace('.', '\\.')));
  }
  assert.match(rehearsal, /grep -Eq '\^\(not ok\|Bail out!\)'/);
  assert.match(rehearsal, /test_transactions_rolled_back=true/);
  assert.match(
    rehearsal,
    /sensitive_partner_state_unchanged_after_migrations=true/,
  );
  assert.match(
    rehearsal,
    /sensitive_partner_state_unchanged_after_tests=true/,
  );
  assert.match(rehearsal, /capture_sensitive_partner_state/);
  assert.match(rehearsal, /pgtap_profile=physical_restore_compatible_v1/);
  assert.match(
    rehearsal,
    /restore_pgtap_\$\{safe_name\}=passed:\$passed_tests/,
  );
  assert.match(rehearsal, /restore_pgtap_files=\$\{#RESTORE_PGTAP_FILES\[@\]\}/);
  assert.match(rehearsal, /restore_pgtap_transaction_guard=true/);
  assert.match(
    workflow,
    /Run exhaustive Partners pgTAP tests on the fresh database[\s\S]*?revenuecat_transfer\.sql[\s\S]*?Run the data-compatible physical restore contract[\s\S]*?affiliate_restore_compatibility\.sql/,
  );

  const normalizedRestorePgTap = restorePgTap.trim();
  assert.match(normalizedRestorePgTap, /^begin;/);
  assert.match(normalizedRestorePgTap, /select extensions\.plan\(\d+\);/);
  assert.match(normalizedRestorePgTap, /select \* from extensions\.finish\(\);/);
  assert.match(normalizedRestorePgTap, /rollback;$/);
  assert.equal(
    (restorePgTap.match(
      /^\s*create extension if not exists pgtap with schema extensions;\s*$/gim,
    ) || []).length,
    1,
    'the rolled-back pgTAP extension is the only allowed restore-test DDL',
  );
  const restorePgTapWithoutExtension = restorePgTap.replace(
    /^\s*create extension if not exists pgtap with schema extensions;\s*$/im,
    '',
  );
  assert.doesNotMatch(
    restorePgTapWithoutExtension,
    /^\s*(?:insert|update|delete|merge|copy|truncate|create|alter|drop|commit)\b/im,
    'the restore contract must not mutate restored business data or schema',
  );
  assert.doesNotMatch(
    restorePgTap,
    /jsonb_array_length[\s\S]{0,120},\s*3\s*,|example\.invalid|10000000-0000-4000/i,
    'the restore contract must not rely on blank-database fixture cardinality',
  );

  assert.match(rehearsal, /umask 077/);
  assert.match(rehearsal, /chmod 0600 "\$PROOF_LOG"/);
  assert.match(rehearsal, /sha256sum "\$PROOF_LOG"/);
  assert.match(rehearsal, /raw_output_retained=false/);
  assert.doesNotMatch(
    rehearsal,
    /set -x|echo "\$POSTGRES_PASSWORD"|-e PGPASSWORD="\$POSTGRES_PASSWORD"/,
  );
  assert.match(
    restoreGuide,
    /sudo bash ops\/hetzner\/backup\/rehearse-partners-physical\.sh/,
  );
  assert.match(restoreGuide, /predeploy/);
  assert.match(restoreGuide, /postdeploy/);
  assert.match(restoreGuide, /migrations_applied=10/);
  assert.match(restoreGuide, /migrations_applied=0/);
  assert.match(restoreGuide, /migration_replay_skipped=true/);
  assert.match(restoreGuide, /--network none/);
  assert.match(restoreGuide, /result=passed/);
  assert.match(restoreGuide, /pgtap_profile=physical_restore_compatible_v1/);
  assert.match(
    workflow,
    /bash -n[\s\S]*?backup-nightly\.sh[\s\S]*?rehearse-partners-physical\.sh/,
  );
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
  assert.match(privacy, /<strong>Hetzner<\/strong>/);
  assert.match(privacy, /<strong>Resend<\/strong>/);
  assert.match(privacy, /Supabase software[\s\S]*does not host this Norva deployment/i);
  assert.doesNotMatch(privacy, /Supabase<\/strong>\s*—\s*authentication and cloud database hosting/i);
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
    runbook,
    /NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED=false/,
  );
  assert.match(
    runbook,
    /Admin live[\s\S]*capacité Risk[\s\S]*AAL2/i,
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
    /supabase\/tests\/affiliate_didit_certification_pre_gate\.sql/,
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
  const pilotPreactivation = read(
    'ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sh',
  );
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
    'NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED',
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
  assert.match(
    example,
    /^NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED=false$/m,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED:\s*\$\{NORVA_PARTNERS_DIDIT_CERTIFICATION_ENABLED:-false\}/,
  );
  assert.match(
    compose,
    /NORVA_PARTNERS_TV_RELAY_HANDOFF_URL:\s*\$\{NORVA_PARTNERS_TV_RELAY_HANDOFF_URL:-https:\/\/norva\.tv\/app\.html\}/,
    'both Edge replicas must default to the Android TV canonical relay landing',
  );
  assert.match(
    example,
    /^NORVA_PARTNERS_TV_RELAY_HANDOFF_URL=https:\/\/norva\.tv\/app\.html$/m,
    'the self-host example must use the exact Android TV relay landing',
  );
  assert.match(
    pilotPreactivation,
    /require_exact "\$container" NORVA_PARTNERS_TV_RELAY_HANDOFF_URL https:\/\/norva\.tv\/app\.html "\$target_name"/,
    'pilot preactivation must reject an Edge replica with a drifting relay landing',
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
