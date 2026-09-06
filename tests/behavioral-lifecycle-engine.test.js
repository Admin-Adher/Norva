'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase', 'migrations', '20260903180000_behavioral_lifecycle_engine_v1.sql');
const hardeningMigration = read('supabase', 'migrations', '20260904090000_behavioral_lifecycle_import_readiness_append_only.sql');
const overviewDigestMigration = read('supabase', 'migrations', '20260904100000_behavioral_lifecycle_admin_overview_digest_schema.sql');
const lifecycle = read('supabase', 'functions', 'norva-lifecycle', 'index.ts');
const cloud = read('supabase', 'functions', 'norva-cloud', 'index.ts');
const norvaAdmin = read('supabase', 'functions', 'norva-admin', 'index.ts');
const deployScript = read('ops', 'hetzner', 'scripts', '04-deploy-edge-functions.sh');
const fcm = read('supabase', 'functions', '_shared', 'fcm.ts');
const lifecycleEmailPath = path.join(root, 'supabase', 'functions', '_shared', 'lifecycle-email.ts');
const lifecycleEmail = fs.readFileSync(lifecycleEmailPath, 'utf8').replace(/\r\n/g, '\n');
const publicView = read('supabase', 'functions', '_shared', 'cloud-public-view.mjs');
const app = read('public', 'js', 'app.js');
const admin = read('public', 'js', 'pages', 'AdminPage.js');
const home = read('public', 'js', 'pages', 'HomePage.js');
const settings = read('public', 'js', 'pages', 'Settings.js');
const sourceManager = read('public', 'js', 'components', 'SourceManager.js');
const account = read('public', 'account.html');
const messaging = read('clients', 'android-phone', 'app', 'src', 'main', 'java', 'tv', 'norva', 'phone', 'NorvaMessagingService.java');
const activity = read('clients', 'android-phone', 'app', 'src', 'main', 'java', 'tv', 'norva', 'phone', 'MainActivity.java');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return source.slice(from, to);
}

test('four approved journeys ship fail-closed for India and Bangladesh', () => {
  for (const key of ['no_source', 'import_unresolved', 'catalog_ready_no_first_play', 'continue_watching']) {
    assert.match(migration, new RegExp(`\\('${key}',[^\\n]+, 'draft', 0, 10, array\\['IN','BD'\\]`));
  }
  assert.match(migration, /status text not null default 'draft'/);
  assert.match(migration, /rollout_percent smallint not null default 0/);
  assert.match(migration, /emergency_stop boolean not null default true/);
  assert.match(migration, /true, true, 'internal_test', 'Fail-closed initial state/);
  assert.match(migration, /not r\.emergency_stop/);
  assert.match(migration, /when 'internal_test' then exists[\s\S]+admin_internal_accounts/);
  assert.match(migration, /when 'pilot' then[\s\S]+country_allowlist[\s\S]+not exists/);
  assert.match(migration, /public\.norva_behavioral_trigger_at\(s\.user_id, p_journey_key\) >= j\.activated_at/);
  for (const field of ['s.registered_at', 's.import_issue_started_at', 's.catalog_ready_at', 's.resume_anchor_at']) {
    assert.ok(migration.includes(field), `missing trigger source ${field}`);
  }
});

test('quiesced deployment proves lifecycle schema and exact runtime protocol before restart', () => {
  assert.match(lifecycle, /const LIFECYCLE_VERSION = 1;/);
  assert.match(lifecycle, /const BEHAVIORAL_LIFECYCLE_PROTOCOL = 1;/);
  assert.match(lifecycle, /req\.method === "GET" && url\.pathname\.endsWith\("\/health"\)/);
  assert.match(lifecycle, /service: "norva-lifecycle",[\s\S]{0,180}version: LIFECYCLE_VERSION,[\s\S]{0,180}behavioralLifecycleProtocol: BEHAVIORAL_LIFECYCLE_PROTOCOL/);
  assert.match(cloud, /behavioralLifecycleProtocol: 1/);

  for (const marker of [
    'EXPECTED_BEHAVIORAL_LIFECYCLE_PROTOCOL=1',
    'EXPECTED_LIFECYCLE_VERSION=1',
    '/home/deno/functions/norva-lifecycle/index.ts',
    '/home/deno/functions/norva-admin/index.ts',
    '/home/deno/functions/norva-branded-email-worker/index.ts',
    'function_health_in_service "$service" norva-lifecycle',
    '\\"behavioralLifecycleProtocol\\":$EXPECTED_BEHAVIORAL_LIFECYCLE_PROTOCOL',
    '\\"version\\":$EXPECTED_LIFECYCLE_VERSION',
  ]) assert.ok(deployScript.includes(marker), `missing deploy protocol proof: ${marker}`);

  for (const relation of [
    'behavioral_lifecycle_runtime',
    'behavioral_lifecycle_journeys',
    'behavioral_lifecycle_steps',
    'behavioral_lifecycle_user_state',
    'behavioral_lifecycle_outbox',
    'behavioral_lifecycle_experiment_versions',
    'behavioral_lifecycle_delivery_events',
    'behavioral_lifecycle_funnel_events',
    'behavioral_lifecycle_import_readiness',
    'behavioral_lifecycle_admin_audit',
  ]) assert.ok(deployScript.includes(`public.${relation}`), `missing deploy relation proof: ${relation}`);

  for (const signature of [
    'public.norva_capture_behavioral_source_attempt(uuid,text,text,text,text,text,uuid)',
    'public.norva_behavioral_lifecycle_tick(integer,integer)',
    'public.norva_claim_behavioral_deliveries(text,integer,integer)',
    'public.norva_authorize_behavioral_push(uuid,uuid)',
    'public.norva_complete_behavioral_push(uuid,uuid,integer,integer,integer,boolean,text)',
    'public.norva_enqueue_behavioral_email(uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)',
    'public.norva_fail_behavioral_email_enqueue(uuid,uuid,text)',
    'public.norva_authorize_behavioral_email_enqueue(uuid,uuid)',
    'public.norva_record_behavioral_delivery_event(uuid,uuid,text)',
    'public.admin_behavioral_lifecycle_overview(integer)',
    'public.admin_record_behavioral_import_readiness(text,text,text,text,boolean,boolean,boolean,boolean,boolean,text)',
    'public.admin_update_behavioral_lifecycle_runtime(boolean,text,text,text)',
    'public.admin_update_behavioral_lifecycle_journey(text,text,integer,integer,text[],text,integer,integer,integer,integer,integer,integer,text,text,text,integer,numeric)',
    'public.admin_update_behavioral_lifecycle_step(text,text,text,integer,text,text,text,text,integer,boolean,boolean,boolean,text)',
    'public.admin_retry_behavioral_lifecycle_delivery(uuid,text,text)',
  ]) assert.ok(deployScript.includes(signature), `missing deploy RPC proof: ${signature}`);

  assert.match(deployScript, /count\(\*\) = 1 and bool_and\(emergency_stop\)/);
  assert.match(deployScript, /quiesced deploy requires behavioral lifecycle schema\/RPCs and emergency stop before Edge restart/);
  assert.match(deployScript, /docker compose[^\n]+ps -q db/s);
  assert.match(deployScript, /DB_CONTAINER="\$behavioral_lifecycle_db_container"[\s\S]+verify-behavioral-lifecycle-pre-activation\.sh/);
  assert.match(deployScript, /observed_lifecycle_digest.*expected_lifecycle_digest/s);
  assert.match(deployScript, /observed_admin_digest.*expected_admin_digest/s);
  for (const sharedFile of [
    'cloud-public-view.mjs',
    'fcm.ts',
    'lifecycle-email.ts',
    'fcm-error.mjs',
    'resend-transport.mjs',
  ]) assert.ok(deployScript.includes(sharedFile), `missing deployed shared digest proof: ${sharedFile}`);
});

test('pre-activation readiness gate is read-only and proves the reviewed dormant install', () => {
  const gateScript = read('ops/hetzner/scripts/verify-behavioral-lifecycle-pre-activation.sh');
  const gateSql = read('ops/hetzner/tests/behavioral_lifecycle_pre_activation_readiness.sql');

  const expectedDigest = gateScript.match(/EXPECTED_MIGRATION_SHA256='([0-9a-f]{64})'/)?.[1];
  const expectedHardeningDigest = gateScript.match(/EXPECTED_HARDENING_MIGRATION_SHA256='([0-9a-f]{64})'/)?.[1];
  const migrationBytes = fs.readFileSync(path.join(
    root, 'supabase', 'migrations', '20260903180000_behavioral_lifecycle_engine_v1.sql',
  ));
  const normalizedMigration = migrationBytes.toString('utf8').replace(/\r/g, '');
  const actualDigest = crypto.createHash('sha256').update(normalizedMigration).digest('hex');
  assert.equal(expectedDigest, actualDigest);
  const hardeningMigrationBytes = fs.readFileSync(path.join(
    root, 'supabase', 'migrations', '20260904090000_behavioral_lifecycle_import_readiness_append_only.sql',
  ));
  const normalizedHardeningMigration = hardeningMigrationBytes.toString('utf8').replace(/\r/g, '');
  const actualHardeningDigest = crypto.createHash('sha256').update(normalizedHardeningMigration).digest('hex');
  assert.equal(expectedHardeningDigest, actualHardeningDigest);
  const expectedConditionalDigest = gateScript.match(/EXPECTED_CONDITIONAL_EMAIL_MIGRATION_SHA256='([0-9a-f]{64})'/)?.[1];
  const conditionalMigration = read('supabase/migrations/20260906125303_no_source_conditional_email_postal.sql');
  assert.equal(expectedConditionalDigest, crypto.createHash('sha256').update(conditionalMigration).digest('hex'));
  assert.match(gateSql, /conditional-email functions missing or drifted/);
  assert.match(gateSql, /conditional-email private helper exposed/);
  assert.match(gateSql, /md5\(replace\(p\.prosrc, chr\(13\), ''\)\)/);
  assert.match(gateSql, /p\.prosecdef is distinct from expected\.definer/);
  assert.match(gateSql, /p\.proconfig is distinct from array\[expected\.path_setting\]/);
  assert.match(gateSql, /\('no_source', 'day_three_email', 3, 'email', 1440/);
  assert.doesNotMatch(gateSql, /\('no_source', 'day_three_email', 3, 'email', 4320/);
  for (const binding of [
    'behavioral_email_not_before', 'behavioral_pending_window', 'defer_behavioral_pending',
    'norva_enqueue_behavioral_email', 'norva_authorize_behavioral_email_enqueue',
    'authorize_branded_email_delivery', 'eligibility', 'claim_postal_branded_email_deliveries',
    'fail_postal_branded_email_delivery',
  ]) assert.ok(gateSql.includes(binding), `missing conditional cadence binding: ${binding}`);
  assert.match(hardeningMigration, /revoke all on table public\.behavioral_lifecycle_import_readiness\s+from service_role/i);
  assert.match(hardeningMigration, /grant select, insert on table public\.behavioral_lifecycle_import_readiness\s+to service_role/i);
  assert.match(overviewDigestMigration, /extensions\.digest\(x\.actor_id::text, ''sha256''\)/i);
  assert.match(overviewDigestMigration, /notify pgrst, 'reload schema'/i);
  assert.match(overviewDigestMigration, /grant execute on function public\.admin_behavioral_lifecycle_overview\(integer\)\s+to authenticated, service_role/i);
  assert.match(gateScript, /tr -d '\\r'/);
  assert.match(gateScript, /default_transaction_read_only=on/);
  assert.match(gateScript, /if \[\[ -n "\$\{PGDATABASE:-\}" \]\]/);
  assert.doesNotMatch(gateScript, /DATABASE_URL/);
  assert.match(gateSql, /begin transaction read only/);
  assert.match(gateSql, /BEHAVIORAL_LIFECYCLE_PRE_ACTIVATION_READY/);
  assert.match(gateSql, /'relations', 10/);
  assert.match(gateSql, /'rpcs', 15/);
  assert.match(gateSql, /'triggers', 12/);
  assert.match(gateSql, /emergency_stop and audience_mode = 'internal_test'/);
  assert.match(gateSql, /outbound-copy gate grants drifted/);
  assert.match(gateSql, /behavioral_lifecycle_steps_safe_copy_check/);
  assert.match(gateSql, /behavioral_lifecycle_outbox_safe_copy_check/);
  assert.match(gateSql, /reviewed outbound copy is unsafe/);
  assert.match(gateSql, /status <> 'draft'/);
  assert.match(gateSql, /rollout_percent <> 0/);
  assert.match(gateSql, /expected exactly eleven reviewed steps/);
  assert.match(gateSql, /pre-activation message or experiment backlog is not empty/);
  assert.match(gateSql, /f\.delivery_id is not null/);
  assert.match(gateSql, /f\.event_name not in \(/);
  assert.match(gateSql, /f\.experiment_arm is not distinct from 'outside_rollout'/);
  assert.match(gateSql, /import attestation is not append-only/);
  assert.match(gateSql, /admin overview digest schema is unsafe/);
  assert.doesNotMatch(
    gateSql,
    /\b(insert|update|delete|truncate|alter|create|drop)\s+(into\s+|from\s+|table\s+|function\s+|trigger\s+)?public\./i,
  );
});

test('dormant deployment evidence is sanitized, immutable and never authorizes a pilot', () => {
  const capture = read('ops/hetzner/scripts/capture-behavioral-lifecycle-dormant-evidence.sh');

  for (const marker of [
    'set +x',
    'umask 077',
    'the evidence output directory must have mode 700',
    'evidence must be written outside the Git checkout',
    'the deployed checkout has tracked modifications',
    'verify-behavioral-lifecycle-pre-activation.sh',
    '20260904090000_behavioral_lifecycle_import_readiness_append_only.sql',
    'docker compose --env-file "$ENV_FILE" -f "$COMPOSE" ps -q db',
    'docker exec "$container" sha256sum',
    'contains_personal_data',
    'contains_secrets',
    'dormant_installation_only',
    'migration_sha256s',
    '"pilot_eligible": False',
    'BEHAVIORAL_LIFECYCLE_PILOT_ELIGIBLE=false',
    'mature_j7_and_j14_outcomes',
  ]) assert.ok(capture.includes(marker), `missing dormant evidence invariant: ${marker}`);

  for (const runtimePath of [
    'norva-cloud/index.ts',
    'norva-lifecycle/index.ts',
    'norva-admin/index.ts',
    'norva-branded-email-worker/index.ts',
    '_shared/cloud-public-view.mjs',
    '_shared/fcm.ts',
    '_shared/lifecycle-email.ts',
    '_shared/fcm-error.mjs',
    '_shared/resend-transport.mjs',
  ]) {
    assert.ok(capture.includes(runtimePath), `missing deployed digest proof for ${runtimePath}`);
  }
  assert.match(capture, /env DB_CONTAINER="\$DB_CONTAINER" DB_USER=supabase_admin DB_NAME=postgres[\s\S]+bash "\$GATE"/);
  assert.match(capture, /os\.link\(temporary, output\)/);
  assert.match(capture, /os\.fchmod\(fd, 0o600\)/);
  for (const format of ['{{.Id}}', '{{.Image}}', '{{.State.Running}}', '{{.State.StartedAt}}']) {
    assert.ok(capture.includes(format), `missing allowlisted container field: ${format}`);
  }
  assert.doesNotMatch(capture, /docker inspect "\$container"\s*>/);
  assert.doesNotMatch(capture, /Config\.Env|\.Config|\["Env"\]/);
});

test('journey steps match the approved timings and conversion exits', () => {
  for (const marker of [
    "('no_source', 'context_help', 1, 'in_app', 15",
    "('no_source', 'day_one_push', 2, 'push', 1440",
    "('no_source', 'day_three_email', 3, 'email', 4320",
    "('import_unresolved', 'error_help', 1, 'in_app', 0",
    "('import_unresolved', 'two_hour_push', 2, 'push', 120",
    "('import_unresolved', 'day_one_email', 3, 'email', 1440",
    "('catalog_ready_no_first_play', 'four_hour_push', 2, 'push', 240",
    "('catalog_ready_no_first_play', 'day_two_push', 3, 'push', 2880",
    "('continue_watching', 'two_day_push', 1, 'push', 2880",
    "('continue_watching', 'new_content_week_push', 2, 'push', 10080",
  ]) assert.ok(migration.includes(marker), marker);
  assert.match(migration, /first_source_attempt_at is null/);
  assert.match(migration, /import_succeeded_at is null or s\.import_succeeded_at < s\.import_issue_started_at/);
  assert.match(migration, /and s\.first_play_at is null/);
  assert.match(migration, /s\.resume_available/);
  assert.match(migration, /last_new_content_at > s\.resume_anchor_at/);
  assert.match(migration, /norva_cancel_behavioral_lifecycle_jobs/);
});

test('outbound lifecycle copy and destinations are fail-closed at the database boundary', () => {
  const copyGuard = section(
    migration,
    'create or replace function public.norva_behavioral_step_copy_safe',
    'create table if not exists public.behavioral_lifecycle_steps',
  );
  for (const marker of [
    'https?://', 'username|password|passwd|token|secret',
    'card[[:space:]]+number', "position('{{' in copy_text)",
    "position('${' in copy_text)", 'requires_new_content',
    "when 'no_source' then p_deep_link = '/app.html#settings/sources'",
    "when 'catalog_ready_no_first_play' then p_deep_link = '/app.html#home'",
    "else '/app.html#home/resume'",
  ]) assert.ok(copyGuard.includes(marker), `missing copy guard: ${marker}`);
  assert.equal(
    (migration.match(/constraint behavioral_lifecycle_(?:steps|outbox)_safe_copy_check check/g) ?? []).length,
    2,
  );
  assert.match(
    migration,
    /admin_update_behavioral_lifecycle_step[\s\S]+or not public\.norva_behavioral_step_copy_safe\(/,
  );
  assert.match(migration, /'New content is waiting'[\s\S]{0,220}false, true\)/);
  assert.match(migration, /last_new_content_at is not null and s\.last_new_content_at > s\.resume_anchor_at/);

  // Rendering remains a second boundary: dynamic copy is escaped and the CTA
  // can only point to the canonical Norva application routes.
  assert.match(lifecycleEmail, /bodyHtml: `<p[\s\S]+\$\{esc\(body\)\}<\/p>`/);
  assert.match(lifecycleEmail, /export function behavioralCtaUrl\(value: unknown\): string \| null/);
  assert.match(lifecycleEmail, /url\.pathname !== "\/app\.html"/);
  assert.match(lifecycleEmail, /deliveryIds\.length !== 1/);
  assert.match(lifecycleEmail, /allowedKeys\.some\(\(key\) => key !== "lifecycleDelivery" && key !== "mobile"\)/);
  assert.match(lifecycleEmail, /settings\\\/sources\\\/help\\\/\(\[a-z_\]\+\)\\\/\(m3u\|xtream\)/);
  assert.match(lifecycleEmail, /BEHAVIORAL_FAILURE_FAMILIES\.has\(contextualHelp\[1\]\)/);
  assert.match(lifecycleEmail, /behavioralCtaUrl\(opts\.ctaUrl\) \?\? OPEN_URL/);
});

test('behavioral email keeps contextual help and rejects noncanonical CTA URLs', async () => {
  const { behavioralCtaUrl, renderBehavioralLifecycle } = await import(pathToFileURL(lifecycleEmailPath).href);
  const deliveryId = '20000000-0000-4000-8000-000000000002';
  const contextual = `https://norva.tv/app.html?lifecycleDelivery=${deliveryId}#settings/sources/help/timeout/m3u`;
  const resume = `https://norva.tv/app.html?lifecycleDelivery=${deliveryId}#home/resume`;
  assert.equal(behavioralCtaUrl(contextual), contextual);
  assert.equal(behavioralCtaUrl(resume), resume);

  for (const unsafe of [
    `https://evil.example/app.html?lifecycleDelivery=${deliveryId}#home`,
    `https://norva.tv/app.html?lifecycleDelivery=${deliveryId}&redirect=https://evil.example#home`,
    `https://norva.tv/app.html?lifecycleDelivery=${deliveryId}#settings/sources/help/not_real/m3u`,
    `https://norva.tv/app.html#home`,
    `https://norva.tv/app.html?lifecycleDelivery=${deliveryId}#home/%72esume`,
  ]) assert.equal(behavioralCtaUrl(unsafe), null, `unsafe CTA accepted: ${unsafe}`);

  const rendered = renderBehavioralLifecycle(null, {
    subject: 'How to finish your Norva import',
    body: 'Review the source format and try again.',
    ctaLabel: 'Review source',
    ctaUrl: contextual,
    flow: 'behavioral_import_unresolved',
  });
  assert.ok(rendered.html.includes(contextual.replaceAll('&', '&amp;')));
  assert.ok(rendered.text.includes(contextual));

  const fallback = renderBehavioralLifecycle(null, {
    subject: 'Review your source', body: 'Try again.', ctaLabel: 'Review source',
    ctaUrl: `https://evil.example/app.html?lifecycleDelivery=${deliveryId}#home`,
    flow: 'behavioral_import_unresolved',
  });
  assert.ok(fallback.text.includes('https://norva.tv/app.html'));
  assert.equal(fallback.text.includes('evil.example'), false);
});

test('one FCM collapse key is enforced per journey and converted in-app prompts disappear', () => {
  for (const [journey, collapseKey] of [
    ['no_source', 'lifecycle-no-source'],
    ['import_unresolved', 'lifecycle-import-unresolved'],
    ['catalog_ready_no_first_play', 'lifecycle-catalog-ready-no-first-play'],
    ['continue_watching', 'lifecycle-continue-watching'],
  ]) {
    const rows = migration.match(new RegExp(`\\('${journey}',[^\\n]+, '${collapseKey}',`, 'g')) ?? [];
    assert.ok(rows.length >= 2, `${journey} does not reuse one collapse key across its sequence`);
  }
  assert.equal(
    (migration.match(/check \(collapse_key = 'lifecycle-' \|\| replace\(journey_key, '_', '-'\)\)/g) ?? []).length,
    2,
  );
  const cancellation = section(
    migration,
    'create or replace function public.norva_cancel_behavioral_lifecycle_jobs',
    'create or replace function public.norva_capture_behavioral_source_attempt',
  );
  assert.match(cancellation, /join public\.cloud_content_events e[\s\S]+e\.kind = 'behavioral_lifecycle'/);
  assert.match(cancellation, /o\.status in \('delivered', 'opened'\)/);
  assert.match(cancellation, /delete from public\.cloud_content_events e/);
  assert.match(cancellation, /message_cancelled_after_conversion/);
});

test('catalog refreshes do not restart first-watch and resume state covers every unfinished title', () => {
  const sourceProjection = section(
    migration,
    'create or replace function public.norva_sync_behavioral_source_state',
    'create or replace function public.norva_sync_behavioral_playback_state',
  );
  assert.match(sourceProjection, /v_first_catalog_ready_transition := v_ready[\s\S]+old\.last_synced_at is null/);
  assert.match(sourceProjection, /coalesce\([\s\S]+behavioral_lifecycle_user_state\.catalog_ready_at,[\s\S]+v_catalog_ready_at/);
  assert.doesNotMatch(sourceProjection, /v_first_catalog_ready_transition := v_ready and \([\s\S]{0,160}old\.last_synced_at is distinct from new\.last_synced_at/);

  const resumeProjection = section(
    migration,
    'create or replace function public.norva_sync_behavioral_resume_state',
    'create or replace function public.norva_sync_behavioral_new_content_state',
  );
  assert.match(resumeProjection, /from public\.cloud_watch_history w/);
  assert.match(resumeProjection, /where w\.user_id = v_user_id/);
  assert.match(resumeProjection, /and not w\.completed/);
  assert.match(resumeProjection, /order by coalesce\(w\.watched_at, w\.updated_at, w\.created_at\) desc/);
  assert.match(resumeProjection, /v_user_id uuid := case when tg_op = 'DELETE' then old\.user_id else new\.user_id end/);
  assert.match(migration, /after insert or delete or update of progress_seconds, duration_seconds, completed, watched_at/);
  assert.doesNotMatch(resumeProjection, /v_resumable boolean := not new\.completed/);
});

test('identity-bearing lifecycle storage is service-only and contains no provider secret payload', () => {
  for (const table of [
    'behavioral_lifecycle_journeys', 'behavioral_lifecycle_steps',
    'behavioral_lifecycle_experiment_versions',
    'behavioral_lifecycle_user_state', 'behavioral_lifecycle_outbox',
    'behavioral_lifecycle_delivery_events', 'behavioral_lifecycle_funnel_events',
    'behavioral_lifecycle_import_readiness',
    'behavioral_lifecycle_admin_audit', 'behavioral_lifecycle_runtime',
  ]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /revoke all on table[\s\S]+behavioral_lifecycle_user_state[\s\S]+from public, anon, authenticated/);
  const state = section(migration, 'create table if not exists public.behavioral_lifecycle_user_state', 'create index if not exists behavioral_lifecycle_user_country_idx');
  const outbox = section(migration, 'create table if not exists public.behavioral_lifecycle_outbox', 'create index if not exists behavioral_lifecycle_outbox_due_idx');
  for (const forbidden of ['provider_url', 'playlist_url', 'username', 'password', 'recipient_email', 'content_id', 'raw_payload']) {
    assert.doesNotMatch(`${state}\n${outbox}`, new RegExp(`\\b${forbidden}\\b`, 'i'));
  }
});

test('push reachability distinguishes accounts, registrations, permission and freshness', () => {
  assert.match(migration, /permission_state in \('unknown', 'prompt', 'granted', 'denied'\)/);
  assert.match(migration, /Existing tokens remain unknown and are not eligible for behavioral push/);
  assert.match(migration, /'total_accounts', \(select count\(\*\) from auth\.users\)/);
  for (const key of ['registered_tokens', 'registered_accounts', 'permission_granted_tokens', 'targetable_tokens', 'targetable_accounts']) {
    assert.match(migration, new RegExp(`'${key}'`));
  }
  assert.match(migration, /permission_state = 'granted'[\s\S]+last_seen_at >= clock_timestamp\(\) - interval '45 days'/);
  assert.match(admin, /comptes inscrits/);
  assert.match(admin, /jetons enregistrés/);
  assert.match(admin, /cibles push éligibles/);
  assert.doesNotMatch(admin, /appareil[^\n<]*joignable/i);
});

test('delivery queue is durable, leased, deduplicated and conservative after uncertain I/O', () => {
  const seeding = section(migration, 'create or replace function public.norva_seed_behavioral_lifecycle_jobs', 'create or replace function public.norva_materialize_behavioral_in_app');
  assert.match(migration, /dedupe_key text not null unique/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /status = 'processing', lease_token = gen_random_uuid\(\)/);
  assert.match(migration, /o\.transport_started_at is not null[\s\S]+then 'dead_letter'/);
  assert.match(migration, /attempt_count < 8/);
  assert.match(migration, /power\(2, least\(o\.attempt_count, 10\)\)/);
  assert.match(migration, /admin_retry_behavioral_lifecycle_delivery/);
  assert.match(migration, /p_confirmation is distinct from 'RETRY ' \|\| p_delivery_id::text/);
  assert.match(migration, /status in \('pending', 'processing', 'email_queued'\)[\s\S]{0,100}transport_started_at is null/);
  assert.match(seeding, /with eligible as[\s\S]+candidates as/);
  assert.match(seeding, /not exists \([\s\S]+where o\.dedupe_key = e\.journey_key/);
  assert.match(seeding, /rollout:' \|\| j\.version::text[\s\S]+< j\.rollout_percent \* 100/);
  assert.match(seeding, /j\.journey_key \|\| ':holdout'/);
  assert.doesNotMatch(seeding, /:holdout:' \|\| j\.version/);
  assert.match(fcm, /isInvalidFcmRegistrationResponse/);
  const pushWorker = section(lifecycle, 'async function runBehavioralPushes', 'async function runBehavioralEmails');
  assert.match(pushWorker, /sent\.unregistered[\s\S]+cloud_push_tokens[\s\S]+\.delete\(\)/);
});

test('email enqueue and link are atomic and final authorization remains fail-closed', () => {
  const atomic = section(migration, 'create or replace function public.norva_enqueue_behavioral_email', 'create or replace function public.norva_fail_behavioral_email_enqueue');
  const finalAuthorization = section(migration, 'create function public.authorize_branded_email_delivery', 'create or replace function public.norva_sync_behavioral_email_state');
  assert.match(atomic, /for update/);
  assert.match(atomic, /norva_behavioral_delivery_eligible/);
  assert.match(atomic, /norva_enqueue_lifecycle_email/);
  assert.match(atomic, /set status = 'email_queued', email_outbox_id/);
  assert.match(atomic, /raise exception 'behavioral email lease lost'/);
  assert.doesNotMatch(lifecycle, /norva_link_behavioral_email/);
  assert.match(lifecycle, /norva_enqueue_behavioral_email/);
  assert.match(migration, /behavioral_eligibility_revoked_before_send/);
  assert.match(migration, /authorize_branded_email_delivery_pre_behavioral/);
  assert.match(atomic, /from public\.behavioral_lifecycle_user_state x[\s\S]{0,100}for update/);
  assert.match(atomic, /norva_behavioral_frequency_allowed_at/);
  assert.match(migration, /o\.status = 'email_queued'[\s\S]{0,120}coalesce\(o\.transport_started_at, o\.updated_at\)/);
  assert.match(migration, /p_exclude_delivery_id uuid default null/);
  assert.match(migration, /p_exclude_delivery_id is null or o\.id <> p_exclude_delivery_id/);
  assert.match(finalAuthorization, /o\.user_id, 'email', o\.journey_key, v_now, o\.id/);
});

test('frequency caps, quiet hours, holdout and typed activation are enforced server-side', () => {
  const relevance = section(migration, 'create or replace function public.norva_behavioral_journey_relevant', 'create or replace function public.norva_behavioral_next_allowed_at');
  assert.match(migration, /max_push_per_day smallint not null default 1/);
  assert.match(migration, /max_push_per_week smallint not null default 3/);
  assert.match(migration, /max_email_per_week smallint not null default 2/);
  assert.match(migration, /max_push_per_day between 0 and 1/);
  assert.match(migration, /max_push_per_week between 0 and 3/);
  assert.match(migration, /max_email_per_week between 0 and 2/);
  assert.match(migration, /v_push_day not between 0 and 1/);
  assert.match(migration, /v_push_week not between 0 and 3/);
  assert.match(migration, /v_email_week not between 0 and 2/);
  assert.match(migration, /quiet_start_hour smallint not null default 21/);
  assert.match(migration, /quiet_end_hour smallint not null default 9/);
  assert.match(migration, /holdout_bucket < c\.holdout_percent \* 100/);
  assert.match(migration, /p_holdout_percent <> 10/);
  assert.match(migration, /p_confirmation is distinct from 'ACTIVATE ' \|\| p_journey_key/);
  assert.match(relevance, /from public\.behavioral_lifecycle_journeys higher/);
  assert.match(relevance, /when 'no_source' then 1[\s\S]+when 'import_unresolved' then 2[\s\S]+when 'catalog_ready_no_first_play' then 3[\s\S]+when 'continue_watching' then 4/);
  assert.match(relevance, /public\.norva_behavioral_state_relevant\([\s\S]+higher\.journey_key/);
  assert.match(admin, /data-lifecycle-field="push-day" type="number" min="0" max="1"/);
  assert.match(admin, /data-lifecycle-field="push-week" type="number" min="0" max="3"/);
  assert.match(admin, /data-lifecycle-field="email-week" type="number" min="0" max="2"/);
  assert.match(migration, /p_confirmation is distinct from v_expected/);
  assert.match(migration, /'EMERGENCY STOP'/);
  assert.match(migration, /'START INTERNAL TEST'/);
  assert.match(migration, /'START PILOT'/);
  assert.match(admin, /Préparer l’activation/);
  assert.match(admin, /Activation non effectuée : confirmation écrite requise/);
  assert.match(admin, /const expected = `ACTIVATE \$\{journey\.key\}`/);
  assert.match(admin, /data-lifecycle-activate disabled/);
  assert.match(admin, /data-lifecycle-runtime-action="internal_test"/);
  assert.match(admin, /data-lifecycle-runtime-action="pilot"/);
  assert.match(admin, /data-lifecycle-runtime-action="stop"/);
});

test('a fresh immutable import-readiness attestation is mandatory for every real pilot delivery', () => {
  const recordReadiness = section(
    migration,
    'create or replace function public.admin_record_behavioral_import_readiness',
    'create or replace function public.admin_update_behavioral_lifecycle_runtime',
  );
  const updateRuntime = section(
    migration,
    'create or replace function public.admin_update_behavioral_lifecycle_runtime',
    'create or replace function public.admin_update_behavioral_lifecycle_journey',
  );
  const relevance = section(
    migration,
    'create or replace function public.norva_behavioral_journey_relevant',
    'create or replace function public.norva_behavioral_next_allowed_at',
  );
  const overview = section(
    migration,
    'create or replace function public.admin_behavioral_lifecycle_overview',
    'revoke all on function public.admin_behavioral_lifecycle_overview(integer)',
  );

  assert.match(migration, /create table if not exists public\.behavioral_lifecycle_import_readiness/);
  assert.match(migration, /evidence_sha256 text not null unique check \(evidence_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(migration, /status = 'passed'[\s\S]+m3u_valid and xtream_valid and large_catalog_valid[\s\S]+error_guidance_valid and android_webview_valid/);
  assert.match(migration, /expires_at > checked_at and expires_at <= checked_at \+ interval '14 days'/);
  assert.match(migration, /grant select, insert on table[\s\S]+behavioral_lifecycle_import_readiness[\s\S]+to service_role/);
  assert.doesNotMatch(migration, /grant select, insert, update, delete on table[\s\S]{0,180}behavioral_lifecycle_import_readiness/);
  assert.match(recordReadiness, /'VERIFY IMPORT READINESS'/);
  assert.match(recordReadiness, /'RECORD IMPORT FAILURE'/);
  assert.match(recordReadiness, /on conflict \(evidence_sha256\) do nothing/);
  assert.match(recordReadiness, /evidence digest already belongs to different coordinates/);
  assert.match(updateRuntime, /fresh passing import readiness evidence required before pilot/);
  assert.match(updateRuntime, /status = 'passed' and r\.expires_at > v_now/);
  assert.match(relevance, /when 'pilot' then[\s\S]+expires_at > coalesce\(p_now, clock_timestamp\(\)\)/);
  assert.match(relevance, /from public\.behavioral_lifecycle_import_readiness g/);
  assert.match(overview, /'import_readiness'/);
  assert.match(overview, /'pilot_gate_open', r\.status = 'passed' and r\.expires_at > v_now/);
  assert.match(admin, /data-lifecycle-import-readiness/);
  assert.match(admin, /admin_record_behavioral_import_readiness/);
  assert.match(admin, /Pilote refusé : enregistrez d’abord une preuve de staging complète et non expirée/);
  assert.match(admin, /const pilotReady = importReadiness\.pilot_gate_open === true/);
  assert.match(admin, /p_confirmation: validation\.expected/);
});

test('each activated experiment version is immutable and changes at most one declared variable', () => {
  const snapshot = section(
    migration,
    'create or replace function public.norva_behavioral_step_experiment_snapshot',
    'create or replace function public.norva_behavioral_experiment_window',
  );
  const updateJourney = section(
    migration,
    'create or replace function public.admin_update_behavioral_lifecycle_journey',
    'create or replace function public.admin_update_behavioral_lifecycle_step',
  );
  assert.match(migration, /create table if not exists public\.behavioral_lifecycle_experiment_versions/);
  assert.match(migration, /experiment_variable in \('baseline', 'delay', 'channel', 'copy', 'cta'\)/);
  assert.match(migration, /target_relative_lift_pct numeric\(7,2\)/);
  assert.match(migration, /'no_source',[^\n]+, 72, 20\.00/);
  assert.match(migration, /'catalog_ready_no_first_play',[^\n]+, 72, 15\.00/);
  for (const family of ['delay', 'channel', 'copy', 'cta', 'structure']) {
    assert.match(snapshot, new RegExp(`'${family}'`));
  }
  assert.match(updateJourney, /v_changed_variables := array_remove/);
  assert.match(updateJourney, /experiment changes more than one variable/);
  assert.match(updateJourney, /experiment must change exactly the declared variable/);
  assert.match(updateJourney, /declared experiment variable has no matching change/);
  assert.match(updateJourney, /insert into public\.behavioral_lifecycle_experiment_versions/);
  assert.match(admin, /data-lifecycle-field="experiment-variable"/);
  assert.match(admin, /data-lifecycle-field="experiment-hypothesis"/);
  assert.match(admin, /data-lifecycle-field="experiment-window"/);
  assert.match(admin, /data-lifecycle-field="experiment-target"/);
  assert.match(admin, /Une seule variable autorisée par nouvelle version/);
});

test('historical state is backfilled without creating historical message events', () => {
  const backfill = section(
    migration,
    '-- Snapshot the pre-existing account population',
    'create or replace function public.norva_behavioral_bucket',
  );
  assert.match(backfill, /from auth\.users u/);
  assert.match(backfill, /left join public\.cloud_signup_attribution/);
  assert.match(backfill, /left join public\.cloud_entitlement_projection/);
  assert.match(backfill, /with source_rollup as/);
  assert.match(backfill, /with event_rollup as/);
  assert.match(backfill, /resume_rollup as/);
  assert.doesNotMatch(backfill, /insert into public\.behavioral_lifecycle_outbox/);
  assert.doesNotMatch(backfill, /insert into public\.behavioral_lifecycle_funnel_events/);
});

test('the required funnel is measured and exposed only as aggregates', () => {
  const funnelInsert = section(
    migration,
    'create or replace function public.norva_insert_behavioral_funnel_event',
    'create or replace function public.behavioral_lifecycle_log_funnel_change',
  );
  const preferenceProjection = section(
    migration,
    'create or replace function public.norva_sync_behavioral_marketing_preference',
    '-- Snapshot the pre-existing account population',
  );
  const experimentWindow = section(
    migration,
    'create or replace function public.norva_behavioral_experiment_window',
    'create or replace function public.norva_behavioral_experiment_safety',
  );
  const experimentSafety = section(
    migration,
    'create or replace function public.norva_behavioral_experiment_safety',
    'create or replace function public.norva_behavioral_experiment_milestones',
  );
  const experimentMilestones = section(
    migration,
    'create or replace function public.norva_behavioral_experiment_milestones',
    'create or replace function public.admin_behavioral_lifecycle_overview',
  );
  const experimentDecision = section(
    migration,
    'create or replace function public.norva_behavioral_experiment_decision',
    'create or replace function public.admin_behavioral_lifecycle_overview',
  );
  const overview = section(
    migration,
    'create or replace function public.admin_behavioral_lifecycle_overview',
    'create or replace function public.admin_update_behavioral_lifecycle_journey',
  );
  for (const event of [
    'message_eligible', 'message_queued', 'message_sent', 'message_provider_accepted',
    'message_delivered', 'message_opened', 'deep_link_opened', 'source_form_opened',
    'source_attempted', 'import_success', 'first_play', 'playback_resumed',
    'trial_started', 'subscription_started', 'message_cancelled_after_conversion',
    'email_unsubscribed',
  ]) assert.match(migration, new RegExp(`'${event}'`));
  assert.match(migration, /'primary_72h'/);
  assert.match(migration, /'dimensions'/);
  assert.match(migration, /s\.first_play_at <= s\.registered_at \+ interval '72 hours'/);
  assert.match(migration, /group by coalesce\(s\.country_code, '\?\?'\), s\.signup_platform/);
  assert.match(migration, /behavioral_lifecycle_funnel_journey_event_idx/);
  assert.match(funnelInsert, /p_event_name in \('trial_started', 'subscription_started'\)/);
  assert.match(funnelInsert, /o\.triggered_at >= v_event_at - interval '7 days'/);
  assert.match(funnelInsert, /where o\.id = v_delivery_id and o\.user_id = p_user_id/);
  assert.match(preferenceProjection, /o\.is_marketing/);
  assert.match(preferenceProjection, /o\.transport_started_at is not null/);
  assert.match(preferenceProjection, /v_attributed_journey, v_attributed_delivery/);
  for (const hours of [24, 72, 168]) {
    assert.match(experimentWindow, new RegExp(`p_window_hours not in \\(24, 72, 168\\)`));
    assert.match(overview, new RegExp(`j\\.journey_key, j\\.version, ${hours}, v_start, v_now`));
  }
  assert.match(experimentWindow, /o\.config_version = p_config_version/);
  assert.match(experimentWindow, /o\.triggered_at <= p_as_of - make_interval\(hours => p_window_hours\)/);
  assert.match(experimentWindow, /admin_internal_accounts/);
  assert.match(experimentSafety, /duplicate_dedupe_keys/);
  assert.match(experimentSafety, /sent_after_conversion/);
  assert.match(experimentSafety, /provider_rejection_rate_pct/);
  assert.match(experimentMilestones, /'day_7_status'/);
  assert.match(experimentMilestones, /'day_14_status'/);
  assert.match(experimentDecision, /'statistical_significance_assessed', false/);
  assert.match(experimentDecision, /'blocked_safety'/);
  assert.match(experimentDecision, /'target_met'/);
  assert.match(experimentDecision, /'baseline_required'/);
  assert.match(experimentDecision, /provider_rejection_guardrail_pp/);
  assert.match(overview, /s\.registered_at <= v_now - interval '72 hours'/);
  assert.match(overview, /'matured_through', v_now - interval '72 hours'/);
  assert.match(overview, /'experiment_windows'/);
  assert.match(overview, /'experiment_safety'/);
  assert.match(overview, /'experiment_plan'/);
  assert.match(overview, /'experiment_decision'/);
  assert.match(overview, /'reporting'/);
  assert.match(admin, /Activation produit sous 72 heures/);
  assert.match(admin, /Cohortes disposant de 72 heures complètes/);
  assert.match(admin, /Expérience 24 h · 72 h · 7 jours/);
  assert.match(admin, /Cohortes matures uniquement/);
  assert.match(admin, /envois après conversion/);
  assert.match(admin, /Rapport J\+7/);
  assert.match(admin, /Décision directionnelle/);
  assert.match(admin, /Cette vue ne calcule pas de significativité statistique/);
});

test('admin configuration is editable, previewable and fully audited while active steps stay immutable', () => {
  assert.match(migration, /create or replace function public\.admin_update_behavioral_lifecycle_runtime/);
  assert.match(migration, /create or replace function public\.admin_update_behavioral_lifecycle_step/);
  assert.match(migration, /if v_journey\.status = 'active'/);
  assert.match(migration, /raise exception 'pause journey before editing a step'/);
  assert.match(migration, /'step_updated'/);
  assert.match(migration, /'delivery_retried'/);
  assert.match(migration, /char_length\(v_reason\) not between 8 and 500/);
  assert.match(admin, /Aperçus du message/);
  assert.match(admin, />Android</);
  assert.match(admin, />Web \/ in-app</);
  assert.match(admin, />Email</);
  assert.match(admin, /Historique auditable/);
  assert.match(admin, /File des échecs permanents/);
  assert.match(admin, /admin_update_behavioral_lifecycle_step/);
  assert.match(admin, /admin_retry_behavioral_lifecycle_delivery/);
});

test('admin copy preflight explains the immutable outbound privacy boundary before save', () => {
  const context = { window: {} };
  vm.runInNewContext(admin, context, { filename: 'AdminPage.js' });
  const validate = context.window.AdminPage.behavioralStepCopyValidation;
  const base = {
    journeyKey: 'no_source',
    title: 'Connect your provider access',
    body: 'Check your username and password, then connect your catalogue.',
    ctaLabel: 'Add a source',
    deepLink: '/app.html#settings/sources',
    requiresNewContent: false,
  };
  assert.equal(validate(base).valid, true, 'generic credential guidance must stay allowed');

  const unsafe = [
    [{ ...base, title: 'Open https://provider.example now' }, 'external_url'],
    [{ ...base, body: 'Write to help@provider.example' }, 'email_address'],
    [{ ...base, body: 'Use provider.example to continue' }, 'external_domain'],
    [{ ...base, body: 'Password: hunter2' }, 'credential_value'],
    [{ ...base, body: 'Card number 4242 4242 4242 4242' }, 'payment_data'],
    [{ ...base, body: 'Hello {{name}}' }, 'interpolation'],
    [{ ...base, body: 'Your latest channels are ready' }, 'unverified_freshness'],
    [{ ...base, body: 'First line\nSecond line' }, 'control_character'],
    [{ ...base, deepLink: '/app.html#home' }, 'wrong_destination'],
    [{ ...base, requiresNewContent: true }, 'freshness_not_supported'],
  ];
  unsafe.forEach(([candidate, expectedCode]) => {
    const result = validate(candidate);
    assert.equal(result.valid, false, expectedCode);
    assert.ok(result.issues.some(issue => issue.code === expectedCode), expectedCode);
  });

  assert.equal(validate({
    ...base,
    journeyKey: 'continue_watching',
    title: 'New titles are available',
    body: 'Open your catalogue and choose what to watch.',
    ctaLabel: 'Open catalogue',
    deepLink: '/app.html#home',
    requiresNewContent: true,
  }).valid, true, 'freshness-backed copy must use the catalogue destination');
  assert.equal(validate({
    ...base,
    journeyKey: 'continue_watching',
    title: 'Continue where you left off',
    body: 'Resume from your saved position.',
    ctaLabel: 'Continue watching',
    deepLink: '/app.html#home/resume',
    requiresNewContent: false,
  }).valid, true, 'resume copy must retain the resume destination');
});

test('all eleven reviewed lifecycle messages pass the same admin copy preflight', () => {
  const context = { window: {} };
  vm.runInNewContext(admin, context, { filename: 'AdminPage.js' });
  const validate = context.window.AdminPage.behavioralStepCopyValidation;
  const seedBlock = section(
    migration,
    'insert into public.behavioral_lifecycle_steps (',
    'on conflict (journey_key, step_key) do nothing;'
  );
  const seedRows = [...seedBlock.matchAll(
    /\('([^']+)', '([^']+)', \d+, '[^']+', \d+, '([^']+)', '([^']+)', '([^']+)', '([^']+)', \d+, '[^']+', false, (true|false)\)/g
  )];
  assert.equal(seedRows.length, 11, 'the reviewed seed inventory must remain complete');
  seedRows.forEach(([, journeyKey, stepKey, title, body, ctaLabel, deepLink, freshness]) => {
    const result = validate({
      journeyKey,
      title,
      body,
      ctaLabel,
      deepLink,
      requiresNewContent: freshness === 'true',
    });
    assert.equal(result.valid, true, `${journeyKey}/${stepKey}: ${JSON.stringify(result.issues)}`);
  });
});

test('native push delivery uses bounded allowlisted deep links and receipt dedupe', () => {
  const completion = section(migration, 'create or replace function public.norva_complete_behavioral_push', 'create or replace function public.norva_enqueue_behavioral_email');
  const receipts = section(migration, 'create or replace function public.norva_record_behavioral_delivery_event', '-- A registered token is not proof');
  assert.match(lifecycle, /dataOnly: true/);
  assert.match(lifecycle, /kind: "behavioral_lifecycle"/);
  assert.match(messaging, /canonicalLifecycleLink/);
  assert.match(messaging, /KEY_LIFECYCLE_SEEN/);
  assert.match(messaging, /MAX_LIFECYCLE_RECEIPTS = 128/);
  assert.match(messaging, /canonicalLifecycleFragment/);
  assert.match(messaging, /"home\/resume"/);
  assert.match(messaging, /"settings"\.equals\(parts\[0\]\)[\s\S]+"help"\.equals\(parts\[2\]\)/);
  assert.match(messaging, /getQueryParameters\("lifecycleDelivery"\)\.size\(\) != 1/);
  assert.match(activity, /drainLifecycleDeliveryReceipts/);
  assert.match(app, /deep_link_opened/);
  for (const route of ['/app.html#settings/sources', '/app.html#home', '/app.html#home/resume']) {
    assert.ok(app.includes(route), `missing web lifecycle route ${route}`);
  }
  assert.match(publicView, /behavioral_lifecycle/);
  assert.match(publicView, /BEHAVIORAL_LIFECYCLE_DEEP_LINKS/);
  assert.match(receipts, /status in \('processing', 'provider_accepted', 'delivered', 'opened'\)/);
  assert.match(receipts, /insert into public\.behavioral_lifecycle_delivery_events[\s\S]+on conflict do nothing/);
  assert.match(completion, /or o\.delivered_at is not null[\s\S]+or o\.opened_at is not null/);
  assert.match(completion, /when o\.opened_at is not null then 'opened'[\s\S]+when o\.delivered_at is not null then 'delivered'/);
});

test('import help and continue-watching deep links resolve safely without secret identifiers', () => {
  const importHelp = section(sourceManager, '    presentLifecycleImportHelp(', '    /**\n     * Render source list');
  assert.match(migration, /'continue_watching', 'two_day_push'[\s\S]{0,300}'\/app\.html#home\/resume'/);
  assert.match(migration, /'failure_family', case when r\.journey_key = 'import_unresolved'/);
  assert.match(migration, /'source_type', case when r\.journey_key = 'import_unresolved'/);
  assert.match(publicView, /journeyKey === "import_unresolved"/);
  assert.match(publicView, /payload\.failureFamily = failureFamily/);
  assert.match(publicView, /payload\.sourceType = sourceType/);
  assert.match(lifecycle, /fragment \+= `\/help\/\$\{failureFamily\}\/\$\{sourceType\}`/);
  assert.match(lifecycle, /mobile: true,[\s\S]{0,200}failureFamily: authorization\.failure_family/);
  assert.match(lifecycle, /mobile: false,[\s\S]{0,200}failureFamily: authorization\.failure_family/);
  assert.ok(app.includes('const match = /^settings\\/sources\\/help\\/([a-z_]+)\\/(m3u|xtream)$/'));
  assert.match(settings, /route\.slice\(separator \+ 1\)\.split\('\/'\)\[0\]/);
  assert.match(importHelp, /Large catalogues are supported/);
  assert.doesNotMatch(importHelp, /context\?\.(?:provider|url|username|password|content)/i);
  assert.match(home, /consumeLifecycleResumeIntent/);
  assert.match(home, /candidate\._upNext/);
  assert.match(home, /this\.openRailItem\(item, true\)/);
  assert.doesNotMatch(lifecycle, /contentId|providerUrl|playlistUrl|username|password/);
});

test('email and browser lifecycle opens are measured without requiring the Android shell', () => {
  assert.match(app, /this\.recordLifecycleDeepLinkFromLocation\(\);/);
  assert.match(app, /url\.searchParams\.get\('lifecycleDelivery'\)/);
  assert.match(app, /sessionStorage\.getItem\(key\)/);
  assert.match(app, /url\.searchParams\.delete\('lifecycleDelivery'\)/);
  assert.match(lifecycle, /if \(options\.mobile === true\) url\.searchParams\.set\("mobile", "1"\)/);
});

test('logged-out lifecycle links survive the complete authentication round trip', () => {
  assert.match(app, /const returnTo = window\.location\.pathname \+ window\.location\.search \+ window\.location\.hash/);
  assert.match(app, /window\.location\.replace\('\/account\.html\?returnTo=' \+ encodeURIComponent\(returnTo \|\| '\/'\)\)/);
  const sanitizer = section(account, '        function sanitizeReturnTo(value)', '        // Start only after tabs');
  assert.match(sanitizer, /const target = `\$\{url\.pathname\}\$\{url\.search\}\$\{url\.hash\}`/);
  assert.match(sanitizer, /url\.pathname === '\/app\.html'[\s\S]+\? target : '\/app#home'/);
  assert.match(account, /location\.replace\(returnTo\)/);
});

test('the public inbox projection preserves only bounded lifecycle context', async () => {
  const publicViewPath = path.join(root, 'supabase', 'functions', '_shared', 'cloud-public-view.mjs');
  const { sanitizeContentEvent } = await import(pathToFileURL(publicViewPath).href);
  const deliveryId = '20000000-0000-4000-8000-000000000002';
  const reminder = sanitizeContentEvent({
    id: deliveryId,
    kind: 'behavioral_lifecycle',
    summary: 'Review your source',
    payload: {
      delivery_id: deliveryId,
      journey_key: 'import_unresolved',
      title: 'Let’s fix this connection',
      body: 'Review the saved details.',
      cta_label: 'Review source',
      deep_link: '/app.html#settings/sources',
      failure_family: 'timeout',
      source_type: 'm3u',
      provider_url: 'https://provider.example/get.php?username=alice&password=secret',
      credentials: { username: 'alice', password: 'secret' },
    },
    created_at: '2026-09-03T00:00:00Z',
  });
  assert.equal(reminder.payload.failureFamily, 'timeout');
  assert.equal(reminder.payload.sourceType, 'm3u');
  const serialized = JSON.stringify(reminder);
  for (const forbidden of ['provider.example', 'alice', 'secret', 'provider_url', 'credentials']) {
    assert.equal(serialized.includes(forbidden), false, `lifecycle inbox leaked ${forbidden}`);
  }

  const resume = sanitizeContentEvent({
    id: '30000000-0000-4000-8000-000000000003',
    kind: 'behavioral_lifecycle',
    payload: {
      delivery_id: '30000000-0000-4000-8000-000000000003',
      journey_key: 'continue_watching',
      deep_link: '/app.html#home/resume',
      title: 'Continue watching', body: 'Your progress is saved.', cta_label: 'Continue',
      failure_family: 'timeout', source_type: 'xtream', content_id: 'private-id',
    },
    created_at: '2026-09-03T00:00:00Z',
  });
  assert.equal(resume.payload.deepLink, '/app.html#home/resume');
  assert.equal(Object.hasOwn(resume.payload, 'failureFamily'), false);
  assert.equal(Object.hasOwn(resume.payload, 'sourceType'), false);
  assert.equal(JSON.stringify(resume).includes('private-id'), false);
});

test('opening the notification inbox records lifecycle message opens independently from seen state', () => {
  assert.match(app, /filter\(e => !e\.seen_at && e\.kind === 'lifecycle'\)/);
  assert.match(app, /new Set\(events[\s\S]*payload\?\.deliveryId/);
  assert.match(app, /lifecycleEvents\.record\(deliveryId, 'opened'\)/);
  assert.match(app, /Promise\.allSettled\(lifecycleOpenIds\.map/);
  assert.match(app, /contentEvents\.markSeen\(unseenIds\)/);
  assert.match(migration, /unique index if not exists behavioral_lifecycle_event_once_idx[\s\S]*'opened'/);
});

test('notification consent remains contextual and under user control', () => {
  assert.match(home, /Let Norva finish in the background/);
  assert.match(home, /data-ecosystem-notifications/);
  assert.match(app, /notificationPermissionState/);
  assert.match(app, /norva:notification-permission-changed/);
  assert.match(cloud, /p_permission_state: permissionState/);
  assert.match(home, /const notificationsButton = e\.target\.closest\('\[data-ecosystem-notifications\]'\)/);
  assert.match(home, /if \(notificationsButton\)[\s\S]{0,800}bridge\.requestNotificationPermission\(\)/);
  assert.doesNotMatch(app, /token\.slice\(0, 12\)/);
  assert.match(messaging, /Manifest\.permission\.POST_NOTIFICATIONS/);
  assert.match(messaging, /manager\.areNotificationsEnabled\(\)/);
  assert.match(messaging, /getNotificationChannel\(channel\)/);
  assert.match(messaging, /getImportance\(\) != NotificationManager\.IMPORTANCE_NONE/);
  assert.match(messaging, /if \(showNotification\([\s\S]{0,220}rememberLifecycleReceipt\(this, deliveryId, "delivered"\)/);
  assert.match(messaging, /catch \(SecurityException ignored\)/);
});

test('all real push audiences exclude internal accounts and every definer has a safe search path', () => {
  const segmentDelivery = section(
    norvaAdmin,
    'async function deliverMarketingSegment',
    'async function deliverMarketingUser',
  );
  assert.match(segmentDelivery, /admin\.rpc\([\s\S]+"marketing_push_targets"/);
  assert.match(segmentDelivery, /\.in\("user_id", userIds\)/);
  assert.doesNotMatch(segmentDelivery, /if \(audience !== "all"\)/);
  const definers = migration.match(/security definer/g) ?? [];
  const safeDefiners = migration.match(/security definer\s+set search_path = (?:''|pg_catalog)/g) ?? [];
  assert.equal(safeDefiners.length, definers.length);
});
