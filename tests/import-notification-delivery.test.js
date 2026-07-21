const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const migration = read('supabase/migrations/20260721230000_import_notification_delivery_outbox.sql');
const source = read('supabase/functions/norva-import-notify/index.ts');
const docs = read('docs/IMPORT-NOTIFICATIONS.md');

test('import notification queue has durable delivery, lease, audit and DLQ state', () => {
  assert.match(migration, /add column if not exists delivery_key uuid/i);
  assert.match(migration, /lease_token uuid/i);
  assert.match(migration, /lease_expires_at timestamptz/i);
  assert.match(migration, /attempt_count integer not null default 0/i);
  assert.match(migration, /next_attempt_at timestamptz not null default now\(\)/i);
  assert.match(migration, /resend_email_id text/i);
  assert.match(migration, /resend_response jsonb/i);
  assert.match(migration, /recipient_email text/i);
  assert.match(migration, /request_from text/i);
  assert.match(migration, /request_reply_to text/i);
  assert.match(migration, /request_subject text/i);
  assert.match(migration, /request_html text/i);
  assert.match(migration, /request_text text/i);
  assert.match(migration, /request_tags jsonb/i);
  assert.match(migration, /prepared_at timestamptz/i);
  assert.match(migration, /dead_lettered_at timestamptz/i);
  assert.match(migration, /status in \('pending', 'processing', 'sent', 'skipped', 'dead_letter'\)/i);
  assert.match(migration, /cloud_import_notifications_lease_check/i);
  assert.match(migration, /cloud_import_notifications_dead_letter_idx/i);
});

test('exact Resend request is frozen under the delivery lease before network I/O', () => {
  const prepare = migration.slice(
    migration.indexOf('create or replace function public.prepare_import_notification_delivery'),
    migration.indexOf('create or replace function public.complete_import_notification_delivery'),
  );
  assert.match(prepare, /v_matched <> v_expected/i);
  assert.match(prepare, /n\.delivery_key = p_delivery_key/i);
  assert.match(prepare, /n\.lease_token = p_lease_token/i);
  assert.match(prepare, /for update;[\s\S]*get diagnostics v_matched = row_count/i);
  assert.match(prepare, /recipient_email = coalesce\(n\.recipient_email, lower\(btrim\(p_recipient_email\)\)\)/i);
  assert.match(prepare, /request_from = coalesce\(n\.request_from, btrim\(p_request_from\)\)/i);
  assert.match(prepare, /request_reply_to = coalesce\(n\.request_reply_to, lower\(btrim\(p_request_reply_to\)\)\)/i);
  assert.match(prepare, /request_subject = coalesce\(n\.request_subject, p_request_subject\)/i);
  assert.match(prepare, /request_html = coalesce\(n\.request_html, p_request_html\)/i);
  assert.match(prepare, /request_text = coalesce\(n\.request_text, p_request_text\)/i);
  assert.match(prepare, /request_tags = coalesce\(n\.request_tags, p_request_tags\)/i);
  assert.match(prepare, /jsonb_typeof\(p_request_tags\) is distinct from 'array'/i);
  assert.match(prepare, /prepared_at = coalesce\(n\.prepared_at, v_now\)/i);
});

test('claim snapshots complete digest groups behind one stable delivery key and lease', () => {
  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_import_notification_deliveries'),
    migration.indexOf('create or replace function public.complete_import_notification_delivery'),
  );
  assert.match(claim, /pg_try_advisory_xact_lock/i);
  assert.match(claim, /n\.delivery_key is null/i);
  assert.match(claim, /group by n\.user_id, n\.kind/i);
  assert.match(claim, /gen_random_uuid\(\) as delivery_key/i);
  assert.match(claim, /set delivery_key = g\.delivery_key/i);
  assert.match(claim, /gen_random_uuid\(\) as lease_token/i);
  assert.match(claim, /status = 'processing'/i);
  assert.match(claim, /attempt_count = n\.attempt_count \+ 1/i);
  assert.match(claim, /array_agg\(c\.id order by c\.id\)/i);
  assert.match(claim, /array_agg\(distinct c\.source_id order by c\.source_id\)/i);
  assert.match(claim, /lease_expires_at <= v_now/i);
  assert.match(claim, /n\.status = 'processing' and n\.lease_expires_at <= v_now/i);
  assert.doesNotMatch(
    claim,
    /attempt_count >= p_max_attempts[\s\S]{0,240}status = 'processing'/i,
    'an ambiguous expired processing lease must remain replayable',
  );
});

test('success acknowledgement is an all-row lease CAS and requires Resend id', () => {
  const complete = migration.slice(
    migration.indexOf('create or replace function public.complete_import_notification_delivery'),
    migration.indexOf('create or replace function public.fail_import_notification_delivery'),
  );
  assert.match(complete, /p_http_status not between 200 and 299/i);
  assert.match(complete, /nullif\(btrim\(p_resend_email_id\), ''\) is null/i);
  assert.match(complete, /v_matched <> v_expected/i);
  assert.match(complete, /for update;[\s\S]*get diagnostics v_matched = row_count/i);
  assert.match(complete, /n\.delivery_key = p_delivery_key/i);
  assert.match(complete, /n\.lease_token = p_lease_token/i);
  assert.match(complete, /resend_email_id = btrim\(p_resend_email_id\)/i);
  assert.match(complete, /payload = '\{\}'::jsonb/i);
  assert.match(complete, /recipient_email = null/i);
  assert.match(complete, /request_from = null/i);
  assert.match(complete, /request_reply_to = null/i);
  assert.match(complete, /request_subject = null/i);
  assert.match(complete, /request_html = null/i);
  assert.match(complete, /request_text = null/i);
  assert.match(complete, /request_tags = null/i);
  assert.match(complete, /resend_response = '\{\}'::jsonb/i);
});

test('delivery failures back off and eventually become dead letters', () => {
  const failure = migration.slice(
    migration.indexOf('create or replace function public.fail_import_notification_delivery'),
    migration.indexOf('create or replace function public.skip_import_notification_delivery'),
  );
  assert.match(failure, /not coalesce\(p_retryable, false\) or v_attempt >= p_max_attempts/i);
  assert.match(failure, /for update;[\s\S]*get diagnostics v_matched = row_count/i);
  assert.match(failure, /power\(2::numeric, greatest\(v_attempt - 1, 0\)\)/i);
  assert.match(failure, /random\(\)/i);
  assert.match(failure, /case when v_terminal then 'dead_letter' else 'pending' end/i);
  assert.match(failure, /return case when v_terminal then 'dead_letter' else 'retry_scheduled' end/i);
  assert.match(migration, /n\.status = 'processing'[\s\S]*n\.lease_expires_at <= now\(\)/i);
});

test('sender resolves current auth email and uses a stable Resend idempotency key', () => {
  const digest = source.slice(source.indexOf('async function runDigest'), source.indexOf('Deno.serve'));
  assert.match(digest, /claim_import_notification_deliveries/);
  assert.match(digest, /if \(!RESEND_API_KEY\) throw new Error\("Resend transport is not configured"\)/);
  assert.match(digest, /db\.auth\.admin\.getUserById\(userId\)/);
  assert.ok(digest.indexOf('claim_import_notification_deliveries') < digest.indexOf('getUserById(userId)'));
  assert.match(digest, /prepare_import_notification_delivery/);
  assert.ok(digest.indexOf('prepare_import_notification_delivery') < digest.indexOf('sendImportEmail('));
  assert.match(digest, /prepared\.recipient_email/);
  assert.match(digest, /prepared\.request_from/);
  assert.match(digest, /prepared\.request_reply_to/);
  assert.match(digest, /prepared\.request_subject/);
  assert.match(digest, /prepared\.request_html/);
  assert.match(digest, /prepared\.request_text/);
  assert.match(digest, /prepared\.request_tags/);
  assert.match(source, /"Idempotency-Key": `norva-import-\$\{deliveryKey\}`/);
  assert.match(source, /typeof response\?\.id === "string"/);
  assert.match(digest, /complete_import_notification_delivery/);
  assert.match(digest, /p_resend_email_id: result\.emailId/);
  assert.match(digest, /p_recipient_email: email/);
  assert.match(digest, /fail_import_notification_delivery/);
  assert.match(digest, /skip_import_notification_delivery/);
  assert.doesNotMatch(digest, /\.from\("cloud_import_notifications"\)\s*\.select/);
  assert.doesNotMatch(digest, /update\(\{ status: "sent"/);
  assert.doesNotMatch(digest, /!email \|\| !RESEND_API_KEY/);
});

test('Resend retry classification preserves recoverable outages and dead-letters bad requests', () => {
  const match = source.match(/function retryableResendStatus\([^)]*\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(match, 'retryableResendStatus must remain extractable');
  const retryable = new Function('status', match[1]);
  for (const status of [null, 401, 403, 408, 425, 429, 500, 503]) {
    assert.equal(retryable(status), true, `${status} should retry`);
  }
  for (const status of [200, 400, 404, 409, 422]) {
    assert.equal(retryable(status), false, `${status} should not retry`);
  }
  const idempotencyClassifier = source.slice(
    source.indexOf('function retryableResendFailure'),
    source.indexOf('async function sendImportEmail'),
  );
  assert.match(idempotencyClassifier, /status === 409/);
  assert.match(idempotencyClassifier, /concurrent_idempotent_requests/);
  assert.doesNotMatch(idempotencyClassifier, /invalid_idempotent_request[^\n]*true/);
  assert.match(source, /retryable: res\.ok \|\| retryableResendFailure\(res\.status, response\)/);
});

test('accepted Resend sends are not overwritten when SQL acknowledgement is ambiguous', () => {
  const start = source.indexOf('const { data: completed, error: completeError }');
  const end = source.indexOf('sent += claim.notification_ids.length', start);
  const acknowledgement = source.slice(start, end);
  assert.match(acknowledgement, /accepted delivery acknowledgement failed/);
  assert.match(acknowledgement, /continue;/);
  assert.doesNotMatch(acknowledgement, /recordFailure/);
});

test('terminal import rows are minimized and retained for bounded periods', () => {
  const skip = migration.slice(
    migration.indexOf('create or replace function public.skip_import_notification_delivery'),
    migration.indexOf('create or replace function public.prune_import_notification_deliveries'),
  );
  assert.match(skip, /payload = '\{\}'::jsonb/i);
  assert.match(skip, /recipient_email = null/i);
  assert.match(skip, /request_html = null/i);
  assert.match(skip, /resend_response = '\{\}'::jsonb/i);
  const prune = migration.slice(
    migration.indexOf('create or replace function public.prune_import_notification_deliveries'),
    migration.indexOf('-- Keep the idle-cron optimization'),
  );
  assert.match(prune, /status in \('sent', 'skipped'\)[\s\S]*interval '90 days'/i);
  assert.match(prune, /status = 'dead_letter'[\s\S]*interval '30 days'/i);
  assert.match(migration, /norva-import-notification-prune/i);
  assert.match(source, /function safeProviderResponse/);
  assert.match(source, /\[email\]/);
  assert.match(source, /\[credential\]/);
});

test('operator documentation explains idempotency, current-email resolution and DLQ inspection', () => {
  assert.match(docs, /Idempotency-Key: norva-import-<delivery_key>/);
  assert.match(docs, /relue dans `auth\.users` apres le claim/);
  assert.match(docs, /payload Resend complet est fige ensemble/);
  assert.match(docs, /concurrent_idempotent_requests/);
  assert.match(docs, /invalid_idempotent_request/);
  assert.match(docs, /90 jours/);
  assert.match(docs, /30 jours/);
  assert.match(docs, /status = 'dead_letter'/);
  assert.match(docs, /expiration du lease|leases? expires/i);
});

test('import delivery cron targets the self-hosted production Edge runtime', () => {
  assert.match(migration, /https:\/\/api\.norva\.tv\/functions\/v1\/norva-import-notify\/cron\/digest/);
  assert.doesNotMatch(migration, /oupsceccxsonaalhueff\.supabase\.co/);
});
