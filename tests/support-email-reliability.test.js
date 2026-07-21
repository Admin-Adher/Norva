const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const support = read('supabase/functions/norva-support/index.ts');
const migration = read('supabase/migrations/20260722002000_support_email_delivery_outbox.sql');
const config = read('supabase/config.toml');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('support message and direction-specific immutable request commit atomically', () => {
  assert.match(migration, /add column if not exists request_id uuid/);
  assert.match(migration, /cloud_support_messages_request_id_uidx/);
  assert.match(migration, /request_id\s+uuid not null unique/);
  assert.match(migration, /unique \(message_id, direction\)/);

  for (const name of [
    'norva_create_support_message_with_email',
    'norva_append_support_message_with_email',
  ]) {
    const fn = section(migration, `create or replace function public.${name}`, 'create or replace function public.');
    assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\('support-request:' \|\| p_request_id::text/);
    assert.ok(fn.indexOf('insert into public.cloud_support_messages') < fn.indexOf('norva_freeze_support_email'));
    assert.match(fn, /'delivery_state', 'ready'/);
  }

  const freeze = section(migration, 'create or replace function public.norva_freeze_support_email', 'create or replace function public.norva_create_support_message_with_email');
  assert.match(freeze, /on conflict \(message_id, direction\) do nothing/);
  assert.match(freeze, /\{\{ticket_ref\}\}/);
  assert.match(freeze, /\{\{ticket_id\}\}/);
  assert.match(freeze, /request_subject,\s+request_html, request_text, request_tags/s);
});

test('Edge routes create, user reply and admin reply through atomic RPCs', () => {
  const create = section(support, 'path === "/create"', 'path === "/reply"');
  assert.match(create, /norva_create_support_message_with_email/);
  assert.doesNotMatch(create, /\.insert\(\{ ticket_id|notifySupport\(/);
  assert.match(create, /email: emailDeliveryView\(result\)/);

  const reply = section(support, 'path === "/reply"', 'path === "/close"');
  assert.match(reply, /norva_append_support_message_with_email/);
  assert.match(reply, /p_from_admin: false/);
  assert.doesNotMatch(reply, /\.insert\(\{ ticket_id|notifySupport\(/);

  const admin = section(support, 'path === "/admin/reply"', 'path === "/admin/status"');
  assert.match(admin, /norva_append_support_message_with_email/);
  assert.match(admin, /p_from_admin: true/);
  assert.doesNotMatch(admin, /getUserById|notifyClient\(/);
  assert.match(admin, /email: emailDeliveryView\(result\)/);
});

test('request_id is validated, atomically serialized and conflict-safe', () => {
  assert.match(support, /const UUID_RE =/);
  assert.match(support, /req\.headers\.get\("x-request-id"\)/);
  assert.match(support, /request_id must be a UUID/);
  assert.match(support, /support_request_id_conflict[\s\S]*409/);
  assert.match(migration, /where m\.request_id = p_request_id/);
  assert.match(migration, /raise exception 'support_request_id_conflict'/);
  assert.match(migration, /support-create:[\s\S]*p_subject[\s\S]*p_body/);
  assert.match(migration, /support-ticket:' \|\| p_ticket_id::text/);
});

test('delivery claims use leases and exact CAS acknowledgement', () => {
  const claim = section(migration, 'create or replace function public.claim_support_email_deliveries', 'create or replace function public.complete_support_email_delivery');
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /lease_token = gen_random_uuid\(\)/);
  assert.match(claim, /transport_started_at = coalesce\(o\.transport_started_at, v_now\)/);
  assert.match(claim, /interval '23 hours'/);
  assert.match(claim, /idempotency_window_expired_manual_review/);

  const complete = section(migration, 'create or replace function public.complete_support_email_delivery', 'create or replace function public.fail_support_email_delivery');
  assert.match(complete, /p_http_status not between 200 and 299/);
  assert.match(complete, /o\.lease_token = p_lease_token/);
  assert.match(complete, /recipient_email = null/);
  assert.match(complete, /request_html = null/);
  assert.match(complete, /payload_scrubbed_at = clock_timestamp\(\)/);
});

test('typed retry distinguishes concurrent 409 from invalid idempotency reuse', () => {
  const match = support.match(/function classifyRetry\([^)]*\): boolean \{([\s\S]*?)\n\}/);
  assert.ok(match);
  const retryable = new Function('status', 'providerCode', 'acceptedWithoutId', match[1]);
  assert.equal(retryable(409, 'concurrent_idempotent_requests', false), true);
  assert.equal(retryable(409, 'request_in_progress', false), true);
  assert.equal(retryable(409, 'idempotency_key_conflict', false), false);
  assert.equal(retryable(400, 'validation_error', false), false);
  assert.equal(retryable(422, 'invalid_parameter', false), false);
  assert.equal(retryable(429, 'rate_limit_exceeded', false), true);
  assert.equal(retryable(503, 'service_unavailable', false), true);
  assert.equal(retryable(null, 'transport_timeout', false), true);
  assert.equal(retryable(200, 'missing_id', true), true);
});

test('worker is sequential, rate-limit aware and preserves ambiguous acceptance', () => {
  const drain = section(support, 'async function drainSupportEmailOutbox', 'async function cronAuthorized');
  assert.match(support, /const SUPPORT_DELIVERY_BATCH = 4/);
  assert.match(support, /const SUPPORT_DELIVERY_SPACING_MS = 300/);
  assert.match(drain, /for \(const claim of claims\)/);
  assert.match(drain, /await sleep\(SUPPORT_DELIVERY_SPACING_MS\)/);
  assert.doesNotMatch(drain, /Promise\.all/);
  assert.match(drain, /sent\.status === 429/);
  assert.match(drain, /defer_support_email_delivery/);
  assert.match(drain, /accepted_unacknowledged\+\+/);

  const sender = section(support, 'async function sendMail', 'function sleep');
  assert.match(sender, /"Idempotency-Key": claim\.delivery_key/);
  assert.match(sender, /AbortSignal\.timeout\(8_000\)/);
  assert.match(sender, /safeProviderResponse\(payload, emailId\)/);
  assert.doesNotMatch(sender, /response: payload/);
});

test('DLQ and retention minimize free-form support data', () => {
  const failure = section(migration, 'create or replace function public.fail_support_email_delivery', 'create or replace function public.defer_support_email_delivery');
  assert.match(failure, /case when v_terminal then 'dead_letter' else 'ready' end/);
  assert.match(failure, /idempotency_window_expired_manual_review/);
  assert.match(failure, /power\(2::numeric/);

  const prune = section(migration, 'create or replace function public.prune_support_email_outbox', 'revoke all on function');
  assert.match(prune, /interval '14 days'/);
  assert.match(prune, /recipient_email = null/);
  assert.match(prune, /request_subject = null/);
  assert.match(prune, /request_html = null/);
  assert.match(prune, /interval '90 days'/);
});

test('support payloads are multipart, escaped and carry product routing tags', () => {
  const templates = section(support, 'function supportTags', 'function redactDiagnostic');
  assert.match(templates, /name: "app", value: "norva"/);
  assert.match(templates, /name: "category", value: "transactional"/);
  assert.match(templates, /support_customer_message/);
  assert.match(templates, /support_agent_reply/);
  assert.equal((templates.match(/\$\{esc\(body\.slice\(0, 4000\)\)\}/g) || []).length, 2);
  assert.match(templates, /text:/);
  assert.doesNotMatch(section(support, 'tags: claim.request_tags', 'signal:'), /email|ticket|subject|body/);
});

test('provider diagnostics are redacted and never returned raw', () => {
  assert.match(support, /\[redacted-email\]/);
  assert.match(support, /\[redacted-url\]/);
  assert.match(support, /\[redacted-secret\]/);
  assert.match(support, /safeProviderResponse/);
  assert.doesNotMatch(support, /console\.error\([^\n]*payload\.message/);
  assert.doesNotMatch(support, /resend_response\s*=\s*payload/);
});

test('cron route self-authenticates and deployment schedules delivery plus pruning', () => {
  assert.match(support, /path === "\/cron\/run"/);
  assert.match(support, /norva_verify_cron_secret/);
  assert.match(config, /\[functions\.norva-support\]\s*\nverify_jwt = false/);
  assert.match(migration, /'norva-support-email-delivery'/);
  assert.match(migration, /norva-support\/cron\/run/);
  assert.match(migration, /'norva-support-email-prune'/);
});
