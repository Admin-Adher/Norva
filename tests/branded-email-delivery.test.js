const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260721235400_branded_email_delivery_outbox.sql');
const worker = read('supabase/functions/norva-branded-email-worker/index.ts');
const docs = read('docs/BRANDED-EMAIL-DELIVERY.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('legacy branded-email signature now transactionally enqueues without provider I/O', () => {
  const enqueue = section(
    migration,
    'create or replace function public.norva_enqueue_branded_email(',
    '-- Backward-compatible seven-argument API',
  );
  const legacy = section(
    migration,
    'create or replace function public.norva_send_branded_email(',
    'revoke all on function public.norva_enqueue_branded_email',
  );
  assert.match(migration, /create table if not exists public\.cloud_branded_email_outbox/);
  assert.match(enqueue, /insert into public\.cloud_branded_email_outbox/);
  assert.match(enqueue, /on conflict \(dedupe_key\) where dedupe_key is not null do nothing/);
  assert.match(legacy, /returns void/);
  assert.match(legacy, /perform public\.norva_enqueue_branded_email/);
  assert.doesNotMatch(legacy, /net\.http_post|api\.resend\.com|vault\.decrypted_secrets|exception when others then null/);
});

test('frozen payload is premium multipart with support reply-to and non-PII tags', () => {
  const enqueue = section(
    migration,
    'create or replace function public.norva_enqueue_branded_email(',
    '-- Backward-compatible seven-argument API',
  );
  assert.match(enqueue, /request_reply_to[\s\S]*'support@norva\.tv'/);
  assert.match(enqueue, /public\.norva_branded_email_html/);
  assert.match(enqueue, /public\.norva_branded_email_text/);
  assert.match(enqueue, /'name', 'category', 'value', 'transactional'/);
  assert.match(enqueue, /'name', 'flow', 'value', v_flow/);
  assert.doesNotMatch(enqueue, /'name',\s*'(?:email|user|recipient|subject|heading|intro)'/);
  assert.match(migration, /request_tags -> 0 ->> 'name' = 'app'/);
  assert.match(migration, /request_tags -> 0 ->> 'value' = 'norva'/);
  assert.match(migration, /request_tags -> 2 ->> 'value' = flow/);

  const html = section(
    migration,
    'create or replace function public.norva_branded_email_html(',
    'create or replace function public.norva_html_fragment_to_text',
  );
  assert.match(html, /<html lang="en">/);
  assert.match(html, /public\.norva_html_escape\(p_heading\)/);
  assert.match(html, /public\.norva_html_escape\(p_cta_url\)/);
  assert.match(html, /public\.norva_html_escape\(p_cta_label\)/);
  assert.match(html, /public\.norva_html_escape\(p_footer\)/);
});

test('security events carry explicit flows, stable dedup and warning observability', () => {
  for (const flow of [
    'security_password_changed',
    'security_email_changed',
    'security_new_device',
  ]) {
    assert.match(migration, new RegExp(`'${flow}'`));
    assert.match(migration, new RegExp(`'${flow}:' \\|\\| encode`));
  }
  assert.match(migration, /raise warning 'Norva password-change email enqueue failed/);
  assert.match(migration, /raise warning 'Norva email-change notification enqueue failed/);
  assert.match(migration, /raise warning 'Norva new-device email enqueue failed/);
});

test('trial dedup and outbox are atomic and no longer depend on the DB Resend key', () => {
  const trial = section(
    migration,
    'create or replace function public.norva_send_trial_ending_reminders',
    '-- ---------------------------------------------------------------------------\n-- Worker lease/CAS API',
  );
  assert.match(migration, /add column if not exists email_delivery_id uuid/);
  assert.match(trial, /v_delivery_id := public\.norva_enqueue_branded_email/);
  assert.match(trial, /'trial_ending'/);
  assert.match(trial, /set email_delivery_id = v_delivery_id/);
  assert.ok(trial.indexOf('insert into public.cloud_trial_reminder_deliveries') <
    trial.indexOf('v_delivery_id := public.norva_enqueue_branded_email'));
  assert.doesNotMatch(trial, /vault\.decrypted_secrets|resend_api_key|net\.http_post/);
});

test('delivery claims are leased with SKIP LOCKED and exact immutable requests', () => {
  const claim = section(
    migration,
    'create or replace function public.claim_branded_email_deliveries',
    'create or replace function public.complete_branded_email_delivery',
  );
  assert.match(claim, /for update skip locked/);
  assert.match(claim, /lease_token = gen_random_uuid\(\)/);
  assert.match(claim, /lease_expires_at = v_now \+ make_interval/);
  assert.match(claim, /attempt_count = o\.attempt_count \+ 1/);
  assert.match(claim, /o\.state = 'processing' and o\.lease_expires_at <= v_now/);
  assert.match(claim, /request_html text/);
  assert.match(claim, /request_text text/);
  assert.match(claim, /request_tags jsonb/);
});

test('success and failure CAS provide idempotent ack, backoff and dead letters', () => {
  const complete = section(
    migration,
    'create or replace function public.complete_branded_email_delivery',
    'create or replace function public.fail_branded_email_delivery',
  );
  assert.match(complete, /p_http_status not between 200 and 299/);
  assert.match(complete, /nullif\(btrim\(p_resend_email_id\), ''\) is null/);
  assert.match(complete, /o\.delivery_key = p_delivery_key/);
  assert.match(complete, /o\.lease_token = p_lease_token/);
  assert.match(complete, /recipient_email = null/);
  assert.match(complete, /request_html = null/);
  assert.match(complete, /request_text = null/);

  const failure = section(
    migration,
    'create or replace function public.fail_branded_email_delivery',
    'create or replace function public.requeue_branded_email_delivery',
  );
  assert.match(failure, /not coalesce\(p_retryable, false\)/);
  assert.match(failure, /power\(2::numeric, greatest\(v_attempt - 1, 0\)\)/);
  assert.match(failure, /'dead_letter'/);
  assert.match(failure, /'retry_scheduled'/);
});

test('Edge worker checks Resend acceptance and preserves ambiguous accepted sends', () => {
  assert.match(worker, /"Idempotency-Key": claim\.delivery_key/);
  assert.match(worker, /text: claim\.request_text/);
  assert.match(worker, /tags: claim\.request_tags/);
  assert.match(worker, /signal: AbortSignal\.timeout\(8_000\)/);
  assert.match(worker, /accepted: res\.ok && Boolean\(emailId\)/);
  assert.match(worker, /complete_branded_email_delivery/);
  assert.match(worker, /accepted_unacknowledged\+\+/);
  const accepted = section(worker, 'if (sent.accepted && sent.emailId)', 'const { data: failure');
  assert.doesNotMatch(accepted, /fail_branded_email_delivery/);
  assert.match(worker, /retryableResendStatus\(sent\.status, sent\.response\)/);
  assert.match(worker, /fail_branded_email_delivery/);
});

test('branded worker respects team rate limits and quarantines stale ambiguous sends', () => {
  assert.doesNotMatch(worker, /Promise\.all\(claims\.map/);
  assert.match(worker, /setTimeout\(resolve, 300\)/);
  assert.match(worker, /concurrent\|in\.\?progress\|already processing/);
  assert.match(worker, /name === "concurrent_idempotent_requests"/);
  assert.match(worker, /name === "invalid_idempotent_request"/);
  assert.match(migration, /ambiguous_delivery_after_idempotency_window/);
  assert.match(migration, /interval '23 hours'/);
  const requeue = section(
    migration,
    'create or replace function public.requeue_branded_email_delivery',
    'create or replace function public.branded_email_delivery_health',
  );
  assert.match(requeue, /last_error is distinct from 'ambiguous_delivery_after_idempotency_window'/);
  assert.match(docs, /Never blindly replay an expired ambiguous row/);
});

test('worker is cron-authenticated and logs no recipient or message content', () => {
  assert.match(worker, /admin\.rpc\("norva_verify_cron_secret"/);
  assert.match(worker, /authorized !== true/);
  assert.match(worker, /if \(!RESEND_API_KEY\)[\s\S]*branded_email_delivery_health/);
  const logs = worker.match(/console\.error\([^;]+;/gs) || [];
  for (const log of logs) {
    assert.doesNotMatch(log, /recipient_email|request_subject|request_html|request_text/);
  }
  assert.ok(worker.includes('.replace(/[A-Z0-9._%+-]+@'));
});

test('runbook documents health, requeue, legacy trial policy and credential model', () => {
  assert.match(docs, /branded_email_delivery_health/);
  assert.match(docs, /requeue_branded_email_delivery/);
  assert.match(docs, /email_delivery_id IS NULL/);
  assert.match(docs, /RESEND_API_KEY/);
  assert.match(docs, /retired DB-side .*Vault copy/i);
});
