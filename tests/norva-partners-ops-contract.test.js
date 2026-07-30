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
  assert.match(verifier, /to_regnamespace\('affiliate_private'\)/);
  assert.match(verifier, /to_regclass\('affiliate_private\.' \|\| v_name\)/);
  assert.match(verifier, /and not c\.relrowsecurity/);
  assert.match(verifier, /has_schema_privilege\(\s*'anon'/);
  assert.match(verifier, /has_table_privilege\(/);
  assert.match(verifier, /has_sequence_privilege\(/);
  assert.match(verifier, /roles\.role_name = 'anon'/);
  assert.match(verifier, /admin_partners_analytics\(integer\)'/);
  assert.match(verifier, /unexpected private Partners EXECUTE privilege/);
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
  assert.match(runbook, /affiliate_private/);
  assert.match(runbook, /deux premiers cycles/i);
  assert.match(runbook, /aucune fonction privée exécutable par `anon`/i);
  assert.match(runbook, /aucun accès direct table ou séquence/i);
  assert.match(runbook, /NORVA-PARTNERS-RELEASE-EVIDENCE\.md/);
  assert.match(runbook, /NORVA-PARTNERS-OBSERVABILITY-CONTRACT\.md/);
  assert.match(
    observability + read('docs/NORVA-PARTNERS-RELEASE-EVIDENCE.md'),
    /Un simple code HTTP `200` n'est pas suffisant/,
  );
  assert.match(observability, /status: unavailable/);
  assert.match(observability, /15 minutes/);
  assert.match(observability, /400\/500/);
  assert.match(observability, /500\/500/);
  assert.match(observability, /financial_transfer_quarantined_recent/);
  assert.match(observability, /Aucun heartbeat payout n'est fabriqué/);
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
    /supabase\/functions\/norva-partners-payout\/index\.ts/,
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
  assert.match(example, /Generate two different values/);
});
